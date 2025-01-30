import { AxiosError, AxiosResponse } from "axios";
import { RequestConfig } from "../request/types";
import { ClientRole } from "../client/types";
import IORedis from "ioredis";
import { v4 } from "uuid";
import zlib from "zlib";
import {
  ApiHealthMonitorConstructorOptions,
  ApiHealthMonitorDowntime,
  ApiHealthMonitorGetMetricsOptions,
  ApiHealthMonitorMetrics,
  ApiHealthMonitorRequest,
  ApiHealthMonitorStatus,
} from "./types";

export default class ApiHealthMonitor {
  public id: string;
  public name: string;
  public dashboardUrl?: string;
  public status: ApiHealthMonitorStatus;
  private role: ClientRole = "slave";
  private failureThreshold: number;
  private redis: IORedis;
  private redisName: string;
  private metricExpiration: number;
  private onlineCheck: () => Promise<boolean> | boolean;
  private onlineCheckIntervalMs: number;
  private onlineCheckThreshold: number;
  private onlineCheckInterval?: NodeJS.Timeout;
  private onApiUp?: () => Promise<void> | void;
  private onApiDown?: () => Promise<void> | void;
  private onMetricsExport?: (
    metrics: ApiHealthMonitorMetrics[]
  ) => Promise<void> | void;
  private onRequestsOffload?: (
    requests: ApiHealthMonitorRequest[]
  ) => Promise<void> | void;
  private offloadMetricsInterval?: NodeJS.Timeout;
  private metricExportIntervalMs: number;
  private aggregateLastMinuteRequestsInterval?: NodeJS.Timeout;

  constructor(data: ApiHealthMonitorConstructorOptions) {
    this.id = v4();
    this.status = "UP";
    this.name = data.name;
    this.failureThreshold = data.failureThreshold || 5; // Defaults to 5
    this.dashboardUrl = data.dashboardUrl;
    this.redis = data.redis;
    this.redisName = `requestHandler:monitor:${data.name.replaceAll(
      / /g,
      "_"
    )}`;
    this.onlineCheck = data.onlineCheck;
    this.onlineCheckIntervalMs = data.onlineCheckIntervalMs || 10000; // Defaults to 10 seconds
    this.onlineCheckThreshold = data.onlineCheckThreshold || 3; // Defaults to 3
    this.onApiUp = data.onApiUp;
    this.onApiDown = data.onApiDown;
    this.onRequestsOffload = data.onRequestsOffload;
    this.onMetricsExport = data.onMetricsExport;
    this.metricExportIntervalMs = data.metricExportIntervalMs || 10000; // Defaults to 1 minute
    this.metricExpiration = data.metricExpiration || 1000 * 60 * 60 * 24 * 30; // Defaults to 30 days
    setInterval(async () => this.expireOldMetrics, 60000);
  }

  public updateRole = async (role: ClientRole) => {
    this.role = role;
    if (role === "master") {
      this.offloadMetricsInterval = setInterval(
        async () => await this.handleOffloadMetrics(),
        this.metricExportIntervalMs
      );
      const timeTillNextMinute = 60000 - (Date.now() % 60000);
      await this.aggregateLastXMinutesRequests();
      setTimeout(() => {
        this.aggregateLastMinuteRequestsInterval = setInterval(
          async () => await this.aggregateLastXMinutesRequests(),
          60000
        );
      }, timeTillNextMinute);
    } else if (role === "slave" && this.offloadMetricsInterval) {
      clearInterval(this.offloadMetricsInterval);
      if (this.aggregateLastMinuteRequestsInterval) {
        clearInterval(this.aggregateLastMinuteRequestsInterval);
      }
    } else return;
  };

  public async logRequest(
    req: RequestConfig,
    res: AxiosResponse | AxiosError | any,
    startTime: Date
  ) {
    const { baseURL, url, method } = req;
    if (!url || !method) return;
    const timestamp = Date.now();
    const latency = timestamp - startTime.getTime();
    if (this.isAxiosError(res) && res.response) {
      await this.markApiDown(res.response.status);
      const requestMetrics: ApiHealthMonitorRequest = {
        timestamp: new Date(timestamp),
        latency,
        status: res.response.status,
        url: baseURL ? `${baseURL}${url}` : `${url}`,
        method,
      };
      await this.redis.zadd(
        `${this.redisName}:requests`,
        timestamp,
        this.compressRequest(requestMetrics)
      );
    } else if (this.isAxiosResponse(res)) {
      const downtimeData = await this.markApiUp();
      const requestMetrics: ApiHealthMonitorRequest = {
        timestamp: new Date(timestamp),
        latency,
        status: res.status,
        url: baseURL ? `${baseURL}${url}` : `${url}`,
        method: method,
        ...(downtimeData
          ? {
              downtime: {
                start: downtimeData.downtimeStart,
                end: downtimeData.timestamp,
                duration:
                  downtimeData.timestamp.getTime() -
                  downtimeData.downtimeStart.getTime(),
              },
            }
          : {}),
      };
      await this.redis.zadd(
        `${this.redisName}:requests`,
        timestamp,
        this.compressRequest(requestMetrics)
      );
    } else return;
  }

  public async getMetrics(
    data: ApiHealthMonitorGetMetricsOptions
  ): Promise<ApiHealthMonitorMetrics[]> {
    const { startTime, endTime, aggregationMinutes } = data;
    const metrics = await this.redis.zrangebyscoreBuffer(
      `${this.redisName}:metrics`,
      startTime.getTime(),
      endTime?.getTime() || Date.now()
    );
    const formattedMetrics = this.decompressAndSortMetrics(metrics);
    const aggregatedMetrics = this.aggregateMetrics(
      formattedMetrics,
      aggregationMinutes
    );
    return Array.from(aggregatedMetrics.entries()).map(([key, value]) => value);
  }

  private isAxiosResponse = (
    response: AxiosResponse | AxiosError | any
  ): response is AxiosResponse => {
    return response.status !== undefined;
  };

  private isAxiosError = (
    response: AxiosResponse | AxiosError | any
  ): response is AxiosError => {
    return response.response !== undefined;
  };

  private async getDowntimeStart() {
    return await this.redis.hget(this.redisName, "downtimeStart");
  }

  private async markApiUp() {
    const timestamp = new Date();
    await this.redis.hset(this.redisName, "failureCount", 0);
    const apiStatus = await this.redis.hget(this.redisName, "status");
    if (apiStatus === "UP") return;
    const downtimeStart = await this.getDowntimeStart();
    if (!downtimeStart) return;
    const onlineCount = await this.redis.hincrby(
      this.redisName,
      "onlineCount",
      1
    );
    if (onlineCount < this.onlineCheckThreshold) return;
    const pipeline = this.redis.pipeline();
    pipeline.hset(this.redisName, "onlineCount", 0);
    pipeline.hdel(this.redisName, `downtimeStart`);
    pipeline.hset(this.redisName, "status", "UP");
    await pipeline.exec();
    if (this.onlineCheckInterval) clearInterval(this.onlineCheckInterval);
    if (this.onApiUp && this.role === "master") await this.onApiUp();
    return { timestamp, downtimeStart: new Date(downtimeStart) };
  }

  private async markApiDown(status: number) {
    const timestamp = Date.now();
    if (status < 500) return;
    await this.redis.hset(this.redisName, "onlineCount", 0);
    const apiStatus = await this.redis.hget(this.redisName, "status");
    if (apiStatus === "DOWN") return;
    const failureCount = await this.redis.hincrby(
      this.redisName,
      "failureCount",
      1
    );
    if (failureCount < this.failureThreshold) return;
    const pipeline = this.redis.pipeline();
    pipeline.hset(this.redisName, "failureCount", 0);
    pipeline.hset(this.redisName, "downtimeStart", `${timestamp}`);
    pipeline.hset(this.redisName, "status", "DOWN");
    await pipeline.exec();
    if (this.onlineCheckInterval) clearInterval(this.onlineCheckInterval);
    this.onlineCheckInterval = setInterval(
      async () => this.checkOnline(),
      this.onlineCheckIntervalMs
    );
    if (this.onApiDown && this.role === "master") await this.onApiDown();
  }

  private compressRequest = (request: ApiHealthMonitorRequest) => {
    const string = `${new Date(request.timestamp).getTime()}|${
      request.latency
    }|${request.status}|${request.url}|${request.method}${
      request.downtime
        ? `|${request.downtime.start.getTime()}|${request.downtime.end.getTime()}|${
            request.downtime.duration
          }`
        : ""
    }`;
    const compressed = zlib.deflateSync(string);
    return compressed;
  };

  private decompressRequest = (request: Buffer): ApiHealthMonitorRequest => {
    const string = zlib.inflateSync(request).toString("utf8");
    const split = string.split("|");
    return {
      timestamp: new Date(Number(split[0])),
      latency: Number(split[1]),
      status: Number(split[2]),
      url: split[3],
      method: split[4],
      ...(split.length > 5
        ? {
            downtime: {
              start: new Date(Number(split[5])),
              end: new Date(Number(split[6])),
              duration: Number(split[7]),
            },
          }
        : {}),
    };
  };

  private async expireOldMetrics() {
    await this.redis.zremrangebyscore(
      `${this.redisName}:metrics`,
      "-inf",
      Date.now() - this.metricExpiration
    );
  }

  private async checkOnline() {
    try {
      await this.onlineCheck();
    } catch (error) {
      await this.redis.hset(this.redisName, "onlineCount", 0);
    }
  }

  private async aggregateLastXMinutesRequests() {
    if (this.role !== "master") return;
    const lastMinute = this.getStartOfPreviousMinute();
    const metrics = await this.getRequestMetricsPerMinute(
      new Date(lastMinute + 59999)
    );
    if (metrics.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const metric of metrics) {
      const compressed = zlib.deflateSync(JSON.stringify(metric));
      pipeline.zadd(
        `${this.redisName}:metrics`,
        metric.startTime.getTime(),
        compressed
      );
    }
    pipeline.zremrangebyscore(
      `${this.redisName}:requests`,
      "-inf",
      lastMinute + 59999
    );
    await pipeline.exec();
  }

  private getStartOfPreviousMinute() {
    const date = new Date();
    date.setSeconds(0);
    date.setMilliseconds(0);
    date.setMinutes(date.getMinutes() - 1);
    return date.getTime();
  }

  private async getRequestMetricsPerMinute(
    endTime: Date
  ): Promise<ApiHealthMonitorMetrics[]> {
    const requests = await this.redis.zrangebyscoreBuffer(
      `${this.redisName}:requests`,
      "-inf",
      endTime.getTime()
    );
    const formattedRequests = this.decompressAndSortRequests(requests);
    if (this.onRequestsOffload) await this.onRequestsOffload(formattedRequests);
    const aggregatedMetrics = this.aggregateRequests(formattedRequests, 1);
    return Array.from(aggregatedMetrics.entries()).map(([key, value]) => {
      return this.getRequestMetrics(value, new Date(key));
    });
  }

  private getRequestMetrics(
    requests: ApiHealthMonitorRequest[],
    startTime: Date
  ): ApiHealthMonitorMetrics {
    let totalLatency = 0;
    let maxLatency = 0;
    let minLatency = 0;
    let statusCodes: Record<string, number> = {};
    let totalDowntime = 0;
    let downtimes: ApiHealthMonitorDowntime[] = [];
    let domains: Record<string, number> = {};
    let methods: Record<string, number> = {};
    for (const request of requests) {
      totalLatency += request.latency;
      if (request.latency > maxLatency) maxLatency = request.latency;
      if (request.latency < minLatency || minLatency === 0) {
        minLatency = request.latency;
      }
      if (request.downtime?.duration) {
        downtimes.push(request.downtime);
        totalDowntime += request.downtime.duration;
      }
      if (request.url) {
        const url = new URL(request.url);
        if (!domains[url.hostname]) domains[url.hostname] = 1;
        else domains[url.hostname]++;
      }
      if (request.method) {
        if (!methods[request.method]) methods[request.method] = 0;
        methods[request.method]++;
      }
      if (request.status) {
        if (!statusCodes[request.status]) statusCodes[request.status] = 0;
        statusCodes[request.status]++;
      }
    }
    return {
      startTime: startTime,
      endTime: new Date(startTime.getTime() + 59999),
      name: this.name,
      requestCount: requests.length,
      statusCodes,
      latency: {
        average: Math.round(totalLatency / requests.length),
        max: maxLatency,
        min: minLatency,
      },
      downtime: {
        total: totalDowntime,
        downtimes,
      },
      domains,
      methods,
    };
  }

  private aggregateRequests(
    data: ApiHealthMonitorRequest[],
    intervalMinutes: number
  ) {
    const aggregatedData: Map<string, ApiHealthMonitorRequest[]> = new Map();
    data.forEach((entry) => {
      const timestamp = new Date(entry.timestamp);
      const intervalKey = this.getIntervalKey(timestamp, intervalMinutes);
      if (aggregatedData.has(intervalKey)) {
        const currentValue = aggregatedData.get(intervalKey) || [];
        aggregatedData.set(intervalKey, [entry, ...currentValue]);
      } else aggregatedData.set(intervalKey, [entry]);
    });
    return aggregatedData;
  }

  private aggregateMetrics(
    data: ApiHealthMonitorMetrics[],
    intervalMinutes: number
  ) {
    const aggregatedData: Map<string, ApiHealthMonitorMetrics[]> = new Map();
    data.forEach((entry) => {
      const timestamp = new Date(entry.startTime);
      const intervalKey = this.getIntervalKey(timestamp, intervalMinutes);
      if (aggregatedData.has(intervalKey)) {
        const currentValue = aggregatedData.get(intervalKey) || [];
        aggregatedData.set(intervalKey, [entry, ...currentValue]);
      } else aggregatedData.set(intervalKey, [entry]);
    });
    const revisedMetrics: ApiHealthMonitorMetrics[] = [];
    for (const [key, value] of aggregatedData.entries()) {
      let requestCount = 0;
      let totalLatency = 0;
      let maxLatency = 0;
      let minLatency = 0;
      let statusCodes: Record<string, number> = {};
      let totalDowntime = 0;
      let downtimes: ApiHealthMonitorDowntime[] = [];
      let domains: Record<string, number> = {};
      let methods: Record<string, number> = {};
      for (const metric of value) {
        requestCount += metric.requestCount;
        totalLatency += metric.latency.average;
        if (metric.latency.max > maxLatency) maxLatency = metric.latency.max;
        if (metric.latency.min < minLatency || minLatency === 0) {
          minLatency = metric.latency.min;
        }
        totalDowntime += metric.downtime.total;
        for (const downtime of metric.downtime.downtimes) {
          downtimes.push(downtime);
        }
        for (const [code, value] of Object.entries(metric.statusCodes)) {
          if (!statusCodes[code]) statusCodes[code] = 0;
          statusCodes[code] += value;
        }
        for (const [d, value] of Object.entries(metric.domains)) {
          if (!domains[d]) domains[d] = value;
          else domains[d] += value;
        }
        for (const [key, value] of Object.entries(metric.methods)) {
          if (!methods[key]) methods[key] = 0;
          methods[key] += value;
        }
      }
      revisedMetrics.push({
        startTime: new Date(key),
        endTime: new Date(
          new Date(key).getTime() + intervalMinutes * 60000 - 1
        ),
        name: this.name,
        requestCount,
        statusCodes,
        latency: {
          average: Math.round(totalLatency / value.length),
          max: maxLatency,
          min: minLatency,
        },
        downtime: {
          total: totalDowntime,
          downtimes,
        },
        domains,
        methods,
      });
    }
    return revisedMetrics;
  }

  private getIntervalKey(timestamp: Date, intervalMinutes: number) {
    const date = new Date(timestamp);
    const roundedDate = new Date(
      Math.floor(date.getTime() / (intervalMinutes * 60 * 1000)) *
        (intervalMinutes * 60 * 1000)
    );
    return roundedDate.toISOString();
  }

  private async handleOffloadMetrics() {
    if (!this.onMetricsExport) return;
    const lastMetricOffloaded = await this.redis.hget(
      this.redisName,
      "lastMetricOffloaded"
    );
    const metrics = await this.redis.zrangebyscoreBuffer(
      `${this.redisName}:metrics`,
      lastMetricOffloaded ? Number(lastMetricOffloaded) + 60000 : "-inf",
      "+inf"
    );
    if (metrics.length === 0) return;
    const formattedRequests = this.decompressAndSortMetrics(metrics);
    const lastMetric = formattedRequests[formattedRequests.length - 1];
    await this.onMetricsExport(formattedRequests);
    await this.redis.hset(
      this.redisName,
      "lastMetricOffloaded",
      new Date(lastMetric.startTime).getTime()
    );
  }

  private decompressAndSortMetrics = (metrics: Buffer[]) => {
    const formattedMetrics = metrics
      .map((metric): ApiHealthMonitorMetrics => {
        return JSON.parse(zlib.inflateSync(metric).toString("utf8"));
      })
      .sort((a, b) => {
        return (
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        );
      });
    return formattedMetrics;
  };

  private decompressAndSortRequests = (requests: Buffer[]) => {
    const formattedRequests = requests
      .map((request): ApiHealthMonitorRequest => {
        return this.decompressRequest(request);
      })
      .sort((a, b) => {
        return (
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
      });
    return formattedRequests;
  };
}
