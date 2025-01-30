import winston from "winston";

const { timestamp, combine, printf, cli } = winston.format;

const consoleTransport = new winston.transports.Console({
  level: "debug",
  format: combine(
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    cli(),
    printf((info) => {
      return `${info.timestamp} ${info.level} Request Handler ${info.message}`;
    })
  ),
});

const logger = winston.createLogger({ transports: [consoleTransport] });

export default logger;
