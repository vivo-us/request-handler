# Request Handler
Request handler makes managing all of your rate limits and authentication much easier by providing a single function to handle all of your requests from all of your registered clients. Simply pass the name of your client and a `AxiosRequestConfig` object to the `handleRequest` function and it will return a promise with the response from the server.

## Table of Contents
- [Request Handler](#request-handler)
  - [Table of Contents](#table-of-contents)
  - [Installation](#installation)
  - [Usage](#usage)
  - [Client Generators](#client-generators)
    - [`requestLimit`](#requestlimit)
      - [Leaky Bucket](#leaky-bucket)
      - [Sliding Window](#sliding-window)
    - [`concurrencyLimit`](#concurrencylimit)
    - [`noLimit`](#nolimit)

## Installation
```bash
npm install request-handler
```

## Usage
```js
import RequestHandler from 'request-handler';

// Using the default client

const requestHandler = new RequestHandler({
    redis: ioRedis, // An IORedis instance
});

await requestHandler.initNode();

const response = await requestHandler.handleRequest({
    url: "https://example.com",
    method: "GET",
});

// Using a named Client

const clientGenerator = () => {
    return [{
      rateLimitType: "requestLimit",
      name: "test",
      interval: 1000,
      tokensToAdd: 1,
      maxTokens: 10,
    }]
}

const requestHandler = new RequestHandler({
    redis: ioRedis, // An IORedis instance
    clientGenerators: [clientGenerator],
});

await requestHandler.initNode();

const response = await requestHandler.handleRequest("test", {
    url: "https://example.com",
    method: "GET",
});
```

## Client Generators
The client generators are functions which return an array of `Client` objects. These clients are then registered with the `RequestHandler` when it is initialized. All `Client` objects have the following properties:
- `name`: The name of the client. This is used to identify the client when making requests.
- `rateLimitType`: The type of rate limit to use. Currently `requestLimit`, `concurrencyLimit`, and `noLimit` types are supported.
- `maxRetries`: The maximum number of times to retry a request if it fails. Defaults to 3.
- `metadata`: Any metadata you want to store with the client. This is useful for storing things like API keys or other information you need to make requests.
- `httpStatusCodesToMute`: An array of HTTP status codes to mute. If an error is returned with one of these codes, the log level will be set to `debug` instead of `error`. This is useful for muting errors that are expected to happen, such as a 404 error.
- `requestInterceptor`: A function that allows requests to be manipulated before they are sent. This is useful for authentcating, adding headers or other information to requests.
- `responseInterceptor`: A function that allows responses to be read in a consistent way. This is useful for reading data from the response, such as rate limit information, or for logging the responses.
- `retryHandler`: A function that allows you to use custom logic to determine whether a request should be retried. This is useful for retrying requests that fail in a consistent way that is not related to the HTTP status code. For example, if you are using a proxy and the proxy fails to connect to the server, you can use this function to retry the request.

Below are the additional properties of each rate limit type and how they are used.

### `requestLimit`
Request limitted clients allow you to limit the number of requests made to a server over a given interval. This is specifically made to handle both Leaky Bucket and Sliding Window rate limits.

Additional properties:
- `interval`: The interval in milliseconds to add tokens to the rate limit.
- `tokensToAdd`: The number of tokens to add to the rate limit each interval.
- `maxTokens`: The maximum number of tokens to store in the rate limit.

#### Leaky Bucket
The below client would be for a rate limit of 1 request per second. The max tokens in this case determine the burst limit of the client.

```js
const clientGenerator = () => {
    return [{
      rateLimitType: "requestLimit",
      name: "test",
      interval: 1000,
      tokensToAdd: 1,
      maxTokens: 10,
    }]
}
```

#### Sliding Window
The below client would be for a rate limit of 10 requests per window, in this case 10 seconds. The max tokens in this case determine the total number of requests allowed in the window. This makes sure that when more tokens are added, it does not exceed the window's limit.

```js
const clientGenerator = () => {
    return [{
      rateLimitType: "requestLimit",
      name: "test",
      interval: 10000,
      tokensToAdd: 10,
      maxTokens: 10,
    }]
}
```

### `concurrencyLimit`
Concurrency limitted clients allow you to limit the number of concurrent requests made to a server.

Additional properties:
- `maxConcurrent`: The maximum number of concurrent requests to allow.

Example:
```js
const clientGenerator = () => {
    return [{
      rateLimitType: "concurrencyLimit",
      name: "test",
      maxConcurrent: 10,
    }]
}
```

### `noLimit`
No limit clients allow you to make requests without any rate limits.

Example:
```js
const clientGenerator = () => {
    return [{
      rateLimitType: "noLimit",
      name: "test",
    }]
}
```