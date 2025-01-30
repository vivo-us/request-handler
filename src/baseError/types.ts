import BaseError from ".";

export interface BaseErrorMetaData {
  /** The context to include with the error. Will be printed to the console */
  context?: string;
  /** Error messages in addition to the main message */
  errors?: (BaseError | Error)[];
  [key: string]: any;
}
