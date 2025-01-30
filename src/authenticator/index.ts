import { RequestConfig } from "../request/types";
import CryptoJS from "crypto-js";
import IORedis from "ioredis";
import {
  AuthCreateData,
  AuthDataToken,
  AuthDataBasic,
  AuthDataOAuth2ClientCredentials,
  AuthDataOAuth2GrantType,
  OAuthResponse,
  OAuthGrantTypeResponse,
} from "./types";

export class Authenticator {
  private redis: IORedis;
  private redisName: string;
  private authData: AuthCreateData;
  private key: string;

  constructor(
    authData: AuthCreateData,
    redis: IORedis,
    redisName: string,
    key: string
  ) {
    this.authData = authData;
    this.redis = redis;
    this.redisName = redisName;
    this.key = key;
  }

  /**
   * This method decides how to authenticate a request based on the authData provided
   *
   * The method will return an object with the header name as the key and the value as the value
   *
   * @param config The request config to authenticate
   * @returns
   */

  public async authenticate(config: RequestConfig) {
    const { type, customPrefix, excludePrefix } = this.authData;
    const headerName = this.authData.customHeaderName || "Authorization";
    const prefix = customPrefix || (type === "basic" ? "Basic" : "Bearer");
    if (config.headers && config.headers[headerName]) return {};
    let value;
    if (type === "token") value = this.handleToken(this.authData);
    else if (type === "basic") value = this.handleBasic(this.authData);
    else value = await this.handleOAuth2(config, this.authData);
    return { [headerName]: `${excludePrefix ? "" : `${prefix} `}${value}` };
  }

  /**
   * This method handles the token authData by encoding it in base64 if needed
   *
   * @param authData The authData to handle
   * @returns
   */

  private handleToken(authData: AuthDataToken) {
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

  private handleBasic(authData: AuthDataBasic) {
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

  private async handleOAuth2(
    config: RequestConfig,
    authData: AuthDataOAuth2ClientCredentials | AuthDataOAuth2GrantType
  ) {
    const existingToken = await this.getExistingToken();
    if (existingToken) return existingToken;
    let newToken;
    if (this.isGrantType(authData)) {
      newToken = await authData.refreshMethod(config, authData);
    } else {
      newToken = await authData.refreshMethod(config, authData);
    }
    await this.saveOAuthData(newToken);
    return newToken.access_token;
  }

  /**
   * This method gets the existing token from the redis cache and checks if it is still valid
   *
   * This method only returns the token if it is still valid and has not expired
   *
   * @returns The existing token if it exists and is still valid
   */

  private async getExistingToken() {
    const existing = await this.redis.hgetall(`${this.redisName}:oauth2`);
    if (!existing.expiresAt) return;
    const expiresAt = new Date(Number(existing.expiresAt)).getTime();
    const expired = expiresAt - new Date().getTime() <= 300000;
    if (!expired) return this.decrypt(existing.accessToken);
  }

  /**
   * This method checks whether the authData is of type OAuth2GrantType
   *
   * @param authData The authData to check
   * @returns
   */

  private isGrantType = (
    authData: AuthCreateData
  ): authData is AuthDataOAuth2GrantType => {
    return authData.type === "oauth2GrantType";
  };

  /**
   * This method saves the OAuth data to the redis cache for future use
   *
   * @param oAuthResponse The OAuth response to save
   */

  private async saveOAuthData(
    oAuthResponse: OAuthResponse | OAuthGrantTypeResponse
  ) {
    const { access_token, expires_in, token_type } = oAuthResponse;
    await this.redis.hset(`${this.redisName}:oauth2`, {
      accessToken: this.encrypt(access_token),
      expiresAt: new Date().getTime() + expires_in * 1000,
      tokenType: token_type,
      ...(oAuthResponse.refresh_token
        ? { refreshToken: this.encrypt(oAuthResponse.refresh_token) }
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

  private decrypt(encrypted: string) {
    const decrypted = CryptoJS.AES.decrypt(encrypted, this.key);
    return decrypted.toString(CryptoJS.enc.Utf8);
  }

  /**
   * Encrypts a given string with the encryption string
   *
   * @param decrypted - The string to encrypt
   */

  private encrypt(decrypted: string) {
    const encrypted = CryptoJS.AES.encrypt(decrypted.trim(), this.key);
    return encrypted.toString();
  }
}
