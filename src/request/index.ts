import { RequestConfig } from "./types";
import { v4 } from "uuid";

export default class Request {
  public id: string;
  public config: RequestConfig;
  public maxRetries: number;
  public retries = 0;

  constructor(config: RequestConfig, maxRetries: number) {
    this.id = v4();
    this.config = config;
    this.maxRetries = maxRetries;
  }
}
