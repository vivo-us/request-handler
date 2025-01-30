# Request Handler

Request Handler is a multi-node capable external API management package that simplifies the process of making requests to external APIs. It provides a centralized method of authenticating requests, handling rate limits, managing multiple clients, and retrying requests. Additionally, it takes the headache out of managing rate limits between multiple nodes by utilizing Redis to notify other nodes of rate limit usage.

## Table of Contents

- [Request Handler](#request-handler)
  - [Table of Contents](#table-of-contents)
  - [Installation](#installation)
  - [Usage](#usage)
    - [Using the default client](#using-the-default-client)
    - [Using a custom client](#using-a-custom-client)
  - [Setup](#setup)
    - [Request Handler Options](#request-handler-options)
    - [Client Options](#client-options)
    - [Rate Limit Options](#rate-limit-options)
      - [requestLimit](#requestlimit)
        - [Leaky Bucket](#leaky-bucket)
        - [Sliding Window](#sliding-window)
      - [concurrencyLimit](#concurrencylimit)
      - [noLimit](#nolimit)
    - [Request Options](#request-options)
    - [Authentication Options](#authentication-options)
      - [OAuth2 Client Credentials](#oauth2-client-credentials)
      - [OAuth2 Grant Type](#oauth2-grant-type)
      - [Token Authentication](#token-authentication)
      - [Basic Authentication](#basic-authentication)

## Installation

```bash
npm install request-handler
```

## Usage

### Using the default client

The default client does not have any customizations applied, it simply makes the request and returns the response.

```js
import RequestHandler from 'request-handler';

const requestHandler = new RequestHandler({
  key: "some-encryption-key", // A key to encrypt sensitive data
  redis: ioRedis, // An IORedis instance
});

await requestHandler.initNode();

const response = await requestHandler.handleRequest({
  url: "https://example.com",
  method: "GET",
});
```

### Using a custom client

Custom clients can have a broad range of customizations applied to them:

- Rate limiting
- Base URL
- Authentication
- Request and response interceptors
- Retry handlers
- Sub-clients

```js
import RequestHandler from 'request-handler';

const clientGenerator = () => {
    return [{
      type: "requestLimit",
      name: "test",
      interval: 1000,
      tokensToAdd: 1,
      maxTokens: 10,
    }]
}

const requestHandler = new RequestHandler({
  key: "some-encryption-key", // A key to encrypt sensitive data
  redis: ioRedis, // An IORedis instance
  clientGenerators: [clientGenerator],
});

await requestHandler.initNode();

const response = await requestHandler.handleRequest("test", {
    url: "https://example.com",
    method: "GET",
});
```

## Setup

Getting started with Request Handler simply requires creating a new instance of the Request Handler class and calling the `initNode` method. This will register the node with the Request Handler and start the rate limiting process. See the [Request Handler Options](#request-handler-options) section for more information on the options available to you.

### Request Handler Options

- `key`: A key to encrypt sensitive data including tokens and client secrets.
- `redis`: An IORedis instance to store rate limit information and for multiple nodes to share rate limits.
- `redisKeyPrefix`: A prefix to add to all keys stored in Redis for the Request Handler.
- `clientGenerators`: An object containing client generators to register with the Request Handler, where the key is the name of the client generator and the value is the generator function.
- `defaultClinetOptions`: A [Client Options](#client-options) object to use for the `default` client. The `default` client starts with no rate limits and no authentication.
- `roleCheckInterval`: The interval in milliseconds for each node to check what it role is. Defaults to 10 seconds (10000 ms).
- `priority`: The priority of the node when deciding which node should handle rate limiting. Defaults to 0. Higher numbers are higher priority.

### Client Options

- `name`: The name of the client. This is used to identify the client when making requests.
- `rateLimit`: An object defining the type of rate limit to use. Currently, there are three types of rate limits: `requestLimit`, `concurrencyLimit`, and `noLimit`. See the [Rate Limit Options](#rate-limit-options) section for more information.
- `rateLimitChange`: A function that is called after each response is received to allow a check of whether the rate limit should be changed.
- `sharedRateLimitClientName`: The name of another client to share rate limits with.
- `requestOptions`: A set of options to pass to each request made by the client. This is useful if there are common parameters that need to be passed to each request. See the [Request Options](#request-options) section for more information.
- `metadata`: Any metadata you want to store with the client.
- `axiosOptions`: Any Axios [Request Config](https://axios-http.com/docs/req_config) options you want to pass to the axios instance for this client.
- `authentication`: An object to define how to authenticate requests. There are currently 4 types of authentication supported: `oauth2ClientCredentials`, `oauth2GrantType`, `token`, and `basic`. See the [Authentication Options](#authentication-options) section for more information.
- `subClients`: An array of clients that will inherit the same rate limts, authentication, and request options as the parent client. This is useful for creating clients that have different endpoints but share the same rate limits and authentication. Any options set on the sub-client will override the parent client's options.

### Rate Limit Options

#### requestLimit

Request limitted clients allow you to limit the number of requests made to a server over a given interval. This is specifically made to handle both Leaky Bucket and Sliding Window rate limits.

Additional properties:

- `interval`: The interval in milliseconds to add tokens to the rate limit.
- `tokensToAdd`: The number of tokens to add to the rate limit each interval.
- `maxTokens`: The maximum number of tokens to store in the rate limit.

##### Leaky Bucket

The below client would be for a rate limit of 1 request per second. The max tokens in this case determine the burst limit of the client.

```js
const clientGenerator = () => {
    return [
      {
        name: "test",
        rateLimit: {
          type: "requestLimit",
          interval: 1000,
          tokensToAdd: 1,
          maxTokens: 10,
        }
      }
    ]
}
```

##### Sliding Window

The below client would be for a rate limit of 10 requests per window, in this case 10 seconds. The max tokens in this case determine the total number of requests allowed in the window. This makes sure that when more tokens are added, it does not exceed the window's limit.

```js
const clientGenerator = () => {
    return [
      {
        name: "test",
        rateLimit: {
          type: "requestLimit",
          interval: 10000,
          tokensToAdd: 10,
          maxTokens: 10,
        }
      }
    ]
}
```

#### concurrencyLimit

Concurrency limitted clients allow you to limit the number of concurrent requests made to a server.

Additional properties:

- `maxConcurrent`: The maximum number of concurrent requests to allow.

```js
const clientGenerator = () => {
    return [
      {
        name: "test",
        rateLimit: {
          type: "concurrencyLimit",
          maxConcurrency: 10
        }
      }
    ]
}
```

#### noLimit

No limit clients allow you to make requests without any rate limits.

```js
const clientGenerator = () => {
    return [
      {
        name: "test",
        rateLimit: {
          type: "noLimit",
        }
      }
    ]
}
```

### Request Options

- `cleanupTimeout`: The number of milliseconds to wait before counting a request as timed out and to clean up the request.
- `metadata`: A general object that can be used to store any metadata you want to pass to the request.
- `retryOptions`: An object that contains options for retrying requests.
  - `maxRetries`: The maximum number of times to retry a request if it fails. Defaults to 3.
  - `retryBackoffBaseTime`: The base time in milliseconds that the retry backoff will calculate from. Defaults to 1000.
  - `retryBackoffMethod`: The method to use for calculating how much time to wait between retry attempts. Options are `exponential` and `linear`. Defaults to `exponential`.
  - `retry429s`: Whether or not to retry 429 errors. Defaults to `true`.
  - `retry5xxs`: Whether or not to retry 5xx errors. Defaults to `true`.
  - `retryHandler`: A function that allows you to use custom logic to determine whether a request should be retried.
  - `retryStatusCodes`: An explicit list of HTTP status codes to retry
- `defaults`: A set of optional default values to pass to each request made by the client.
  - `headers`: A set of headers to pass to each request made by the client.
  - `baseURL`: The base URL to use for each request made by the client.
  - `params`: A set of query parameters to pass to each request made by the client.
- `httpStatusCodesToMute`: A list of HTTP status codes to not log as errors. By default, all 4xx and 5xx status codes are logged as errors.
- `requestInterceptor`: A function that allows requests to be manipulated before they are sent. This is useful for authentcating, adding headers or other information to requests.
- `responseInterceptor`: A function that allows responses to be read in a consistent way. This is useful for reading data from the response, such as rate limit information, or for logging the responses.

### Authentication Options

#### OAuth2 Client Credentials

- `type`: set to `oauth2ClientCredentials`
- `clientId`: The client ID for the OAuth2 client.
- `clientSecret`: The client secret for the OAuth2 client.
- `metadata`: Any optional metadata you want to store with the authentication client.
- `customHeaderName`: An option to override the default `Authorization` header for the access token.
- `customPrefix`: An option to override the default `Bearer` prefix for the access token.
- `excludePrefix`: An option to exclude the prefix from the access token.
- `refreshMethod`: A function that accepts the request config, `clientId`, `clientSecret`, and `metadata`, and returns a OAuth2 response with an updated access token.

#### OAuth2 Grant Type

- `type`: set to `oauth2GrantType`
- `clientId`: The client ID for the OAuth2 client.
- `clientSecret`: The client secret for the OAuth2 client.
- `refreshToken`: The refresh token used to get a new access token.
- `metadata`: Any optional metadata you want to store with the authentication client.
- `customHeaderName`: An option to override the default `Authorization` header for the access token.
- `customPrefix`: An option to override the default `Bearer` prefix for the access token.
- `excludePrefix`: An option to exclude the prefix from the access token.
- `refreshMethod`: A function that accepts the request config, `clientId`, `clientSecret`, `refreshToken`, and `metadata`, and returns a OAuth2 response with an updated access token.

#### Token Authentication

- `type`: set to `token`
- `token`: The token to use for authentication.
- `encodeBase64`: Whether or not to encode the token in base64 in the header.
- `customHeaderName`: An option to override the default `Authorization` header for the access token.
- `customPrefix`: An option to override the default `Bearer` prefix for the access token.
- `excludePrefix`: An option to exclude the prefix from the access token.

#### Basic Authentication

- `type`: set to `basic`
- `username`: The username to use for basic authentication.
- `password`: The password to use for basic authentication.
- `customHeaderName`: An option to override the default `Authorization` header for the access token.
- `customPrefix`: An option to override the default `Basic` prefix for the access token.
- `excludePrefix`: An option to exclude the prefix from the access token.
