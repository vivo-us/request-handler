import { AxiosRequestConfig } from "axios";
import CryptoJS from "crypto-js";
import Client from "../";
import {
  AuthDataBasic,
  AuthDataOAuth2ClientCredentials,
  AuthDataOAuth2GrantType,
  AuthDataToken,
  OAuthGrantTypeResponse,
  OAuthResponse,
} from "../types";

/**
 * This method decides how to authenticate a request based on the authData provided
 *
 * The method will return an object with the header name as the key and the value as the value
 *
 * @param config The request config to authenticate
 * @returns
 */

async function authenticate(this: Client) {
  if (!this.authData) return;
  const { type, customPrefix, excludePrefix } = this.authData;
  const headerName = this.authData.customHeaderName || "Authorization";
  const prefix = customPrefix || (type === "basic" ? "Basic" : "Bearer");
  let value;
  if (type === "token") value = handleToken(this.authData);
  else if (type === "basic") value = handleBasic(this.authData);
  else value = await handleOAuth2.bind(this)(this.authData);
  return { [headerName]: `${excludePrefix ? "" : `${prefix} `}${value}` };
}

/**
 * This method handles the token authData by encoding it in base64 if needed
 *
 * @param authData The authData to handle
 * @returns
 */

function handleToken(authData: AuthDataToken) {
  return authData.encodeBase64
    ? Buffer.from(authData.token).toString("base64")
    : authData.token;
}

/**
 * This method handles the basic authData by encoding the username and password in base64
 *
 * @param authData The authData to handle
 * @returns
 */

function handleBasic(authData: AuthDataBasic) {
  return Buffer.from(`${authData.username}:${authData.password}`).toString(
    "base64"
  );
}

/**
 * This method handles the OAuth2 authData by first checking if there is an existing token that is still valid in the redis cache, if not it will refresh the token and save it to the cache
 *
 * @param config The request config to authenticate
 * @param authData The authData to handle
 * @returns
 */

async function handleOAuth2(
  this: Client,
  authData: AuthDataOAuth2ClientCredentials | AuthDataOAuth2GrantType
) {
  const existingToken = await getExistingToken.bind(this)();
  if (existingToken) return existingToken;
  const newToken = await handleRefreshMethod.bind(this)(authData);
  await saveOAuthData.bind(this)(newToken);
  return newToken.access_token;
}

/**
 * This method gets the existing token from the redis cache and checks if it is still valid
 *
 * This method only returns the token if it is still valid and has not expired
 *
 * @returns The existing token if it exists and is still valid
 */

async function getExistingToken(this: Client) {
  const existing = await this.redis.hgetall(`${this.redisName}:oauth2`);
  if (!existing.expiresAt) return;
  const expiresAt = new Date(Number(existing.expiresAt)).getTime();
  const expired = expiresAt - new Date().getTime() <= 300000;
  if (!expired) return decrypt.bind(this)(existing.accessToken);
}

async function handleRefreshMethod(
  this: Client,
  authData: AuthDataOAuth2ClientCredentials | AuthDataOAuth2GrantType
) {
  if (authData.refreshConfig.requestInterceptor) {
    authData.refreshConfig = await authData.refreshConfig.requestInterceptor(
      authData.refreshConfig
    );
  }
  const config = generateConfig(authData);
  const res = await this.http(config);
  let oAuthResponse: OAuthResponse | OAuthGrantTypeResponse;
  if (authData.refreshConfig.responseInterceptor) {
    oAuthResponse = await authData.refreshConfig.responseInterceptor(res);
  } else oAuthResponse = res.data;
  return oAuthResponse;
}

function generateConfig(
  authData: AuthDataOAuth2ClientCredentials | AuthDataOAuth2GrantType
) {
  const { refreshConfig, clientId, clientSecret } = authData;
  const { url, data, dataLocation, useBasicAuth } = refreshConfig;
  const config: AxiosRequestConfig = {
    method: "POST",
    url: url,
    headers: { ...refreshConfig?.customHeaders, Accept: "application/json" },
  };
  if (useBasicAuth) {
    if (!config.headers) config.headers = {};
    const buffer = Buffer.from(`${clientId}:${clientSecret}`);
    config.headers.Authorization = `Basic ${buffer.toString("base64")}`;
  }
  for (const key in data) {
    switch (data[key]) {
      case "{{clientId}}":
        data[key] = clientId;
        break;
      case "{{clientSecret}}":
        data[key] = clientSecret;
        break;
      case "{{refreshToken}}":
        if (authData.type === "oauth2GrantType") {
          data[key] = authData.refreshToken;
        }
        break;
    }
  }
  switch (dataLocation) {
    case "urlEncodedForm":
      const formParams = new URLSearchParams();
      if (!config.headers) config.headers = {};
      config.headers["Content-Type"] = "application/x-www-form-urlencoded";
      for (const key in data) {
        formParams.append(key, data[key]);
      }
      config.data = formParams.toString();
      break;
    case "urlQuery":
      const queryParams = new URLSearchParams();
      for (const key in data) {
        queryParams.append(key, data[key]);
      }
      config.url += `?${queryParams.toString()}`;
      break;
    case "jsonBody":
      if (!config.headers) config.headers = {};
      config.headers["Content-Type"] = "application/json";
      config.data = data;
      break;
  }
  return config;
}

/**
 * This method saves the OAuth data to the redis cache for future use
 *
 * @param oAuthResponse The OAuth response to save
 */

async function saveOAuthData(
  this: Client,
  oAuthResponse: OAuthResponse | OAuthGrantTypeResponse
) {
  const { access_token, expires_in, token_type } = oAuthResponse;
  await this.redis.hset(`${this.redisName}:oauth2`, {
    accessToken: encrypt.bind(this)(access_token),
    expiresAt: new Date().getTime() + expires_in * 1000,
    tokenType: token_type,
    ...(oAuthResponse.refresh_token
      ? { refreshToken: encrypt.bind(this)(oAuthResponse.refresh_token) }
      : {}),
    ...(oAuthResponse.refresh_token_expires_in
      ? {
          refreshTokenExpiresAt:
            new Date().getTime() +
            oAuthResponse.refresh_token_expires_in * 1000,
        }
      : {}),
  });
}

/**
 * Decrypts a given string with the encryption string
 *
 * @param encrypted - The string to decrypt
 */

function decrypt(this: Client, encrypted: string) {
  const decrypted = CryptoJS.AES.decrypt(encrypted, this.key);
  return decrypted.toString(CryptoJS.enc.Utf8);
}

/**
 * Encrypts a given string with the encryption string
 *
 * @param decrypted - The string to encrypt
 */

function encrypt(this: Client, decrypted: string) {
  const encrypted = CryptoJS.AES.encrypt(decrypted.trim(), this.key);
  return encrypted.toString();
}

export default authenticate;
