import IORedis from "ioredis";

export type ApiHealthMonitorStatus = "UP" | "DOWN";

export interface CreateApiHealthMonitorData {
  /**
   * The name of the API health monitor
   *
   * NOTE: If you want multiple clients to use the same API health monitor, they must have the same name.
   */
  name: string;

  /** A function to run when the API is down to check when it comes back online */
  onlineCheck: () => Promise<boolean> | boolean;
  /**
   * How often to run the online check function when the API is down.
   *
   * **Default value: 10000 ms**
   */
  onlineCheckIntervalMs?: number;
  /**
   * How many times an online check needs to pass for an API to be considered back online
   *
   * **Default value: 3**
   */
  onlineCheckThreshold?: number;
  /** The failure threshold of the API health monitor */
  failureThreshold?: number;
  /** The URL to the API owner's official dashboard */
  dashboardUrl?: string;
  /**
   * How long to keep metrics for in ms.
   *
   * **Default value: 30 days**
   */
  metricExpiration?: number;
  /**
   * A function to run if an API goes down
   *
   * NOTE: This function will only be called if the ApiHealthMonitor is on the master node
   */
  onApiDown?: () => Promise<void> | void;
  /**
   * A function to run if an API comes back up
   *
   * NOTE: This function will only be called if the ApiHealthMonitor is on the master node
   */
  onApiUp?: () => Promise<void> | void;
  /** How often to export metrics */
  metricExportIntervalMs?: number;
  /**
   * A function to run to export metrics
   *
   * NOTE: This function will only be called if the ApiHealthMonitor is on the master node
   */
  onMetricsExport?: (
    metrics: ApiHealthMonitorMetrics[]
  ) => Promise<void> | void;
  /**
   * A function to run to offload requests
   *
   * Will be called once per minute as it aggregates requests by minute
   *
   * NOTE: This function will only be called if the ApiHealthMonitor is on the master node
   */
  onRequestsOffload?: (
    requests: ApiHealthMonitorRequest[]
  ) => Promise<void> | void;
}

export interface ApiHealthMonitorConstructorOptions
  extends CreateApiHealthMonitorData {
  /** The Redis instance to use */
  redis: IORedis;
}

export interface ApiHealthMonitorMetrics {
  name: string;
  startTime: Date;
  endTime: Date;
  requestCount: number;
  methods: Record<string, number>;
  statusCodes: Record<string, number>;
  latency: ApiHealthMonitorLatencyMetrics;
  downtime: ApiHealthMonitorDowntimeMetrics;
  domains: Record<string, number>;
}

export interface ApiHealthMonitorDowntimeMetrics {
  total: number;
  downtimes: ApiHealthMonitorDowntime[];
}

export interface ApiHealthMonitorLatencyMetrics {
  average: number;
  min: number;
  max: number;
}

export interface ApiHealthMonitorRequest {
  timestamp: Date;
  latency: number;
  url: string;
  method: string;
  status: number;
  downtime?: ApiHealthMonitorDowntime;
}

export interface ApiHealthMonitorGetMetricsOptions {
  startTime: Date;
  endTime?: Date;
  aggregationMinutes: number;
}

export interface ApiHealthMonitorDowntime {
  start: Date;
  end: Date;
  /** Duration of the downtime in ms */
  duration: number;
}
