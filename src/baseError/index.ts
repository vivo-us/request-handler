import { BaseErrorMetaData } from "./types";
import logger from "../logger";
import { v4 } from "uuid";

export default class BaseError extends Error {
  public errorId: string;
  metaData?: BaseErrorMetaData;

  /**
   * @param code - The error code
   * @param metaData - Any additional data to log with the error
   */

  constructor(message: string, metaData?: BaseErrorMetaData) {
    const errorId = v4();
    super(message);
    this.metaData = metaData;
    this.errorId = errorId;
    const errMetadata = {
      errorId: this.errorId,
      metaData: this.metaData
        ? JSON.stringify(this.metaData).length < 255 * 1024
          ? this.metaData
          : "data too large"
        : undefined,
    };
    logger.error(
      `Error ${errorId}: ${this.message}${
        this.metaData?.context ? `\n - Context: ${this.metaData.context}` : ""
      }`,
      errMetadata
    );
  }
}
