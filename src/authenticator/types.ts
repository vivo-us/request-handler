import { RequestConfig } from "../request/types";

export type AuthCreateData =
  | AuthDataOAuth2ClientCredentials
  | AuthDataOAuth2GrantType
  | AuthDataToken
  | AuthDataBasic;

export interface AuthDataOAuth2ClientCredentials
  extends OAuthBaseData,
    CustomHeader {
  type: "oauth2ClientCredentials";
  refreshMethod: (
    config: RequestConfig,
    authData: OAuthBaseData
  ) => Promise<OAuthResponse> | OAuthResponse;
}

export interface AuthDataOAuth2GrantType extends OAuth2GrantData, CustomHeader {
  type: "oauth2GrantType";
  refreshMethod: (
    config: RequestConfig,
    authData: OAuth2GrantData
  ) => Promise<OAuthResponse> | OAuthResponse;
}

export interface OAuth2GrantData extends OAuthBaseData {
  refreshToken: string;
}

export interface AuthDataToken extends CustomHeader {
  type: "token";
  token: string;
  /** Whether or not to encode in Base64 */
  encodeBase64?: boolean;
}

export interface AuthDataBasic extends CustomHeader {
  type: "basic";
  username: string;
  password: string;
}

export interface OAuthBaseData {
  clientId: string;
  clientSecret: string;
  /** Additional metdata for passing additional info */
  metadata?: { [key: string]: any };
}

export interface OAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface OAuthGrantTypeResponse extends OAuthResponse {
  refresh_token: string;
}

export interface CustomHeader {
  /** A Custom header to include the token in */
  customHeaderName?: string;
  /** A Custom prefix to use in front of the token. Default to "Bearer" */
  customPrefix?: string;
  /** Whether or not to exclude a prefix. Default to false */
  excludePrefix?: boolean;
}
