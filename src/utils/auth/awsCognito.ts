import got from 'got';
import type { BeforeRequestHook } from 'got';

/**
 * AWS Cognito authentication.
 *
 * The original implementation imported the whole of `aws-amplify` — GraphQL,
 * DataStore, machine-learning predictions, pubsub, notifications — to perform
 * one sign-in: 17 MB on disk and 41 packages with known vulnerabilities.
 *
 * Cognito is an ordinary HTTP API, so here it is called directly. Same
 * behaviour, same syntax in the `.http` file, no SDK.
 */

const TARGET = 'AWSCognitoIdentityProviderService.InitiateAuth';

interface CognitoResponse {
  AuthenticationResult?: {
    AccessToken?: string;
    IdToken?: string;
  };
  ChallengeName?: string;
  message?: string;
  __type?: string;
}

async function login(
  username: string,
  password: string,
  region: string,
  _userPoolId: string,
  clientId: string,
): Promise<{ idToken: string; accessToken: string }> {
  let body: CognitoResponse;
  try {
    body = await got
      .post(`https://cognito-idp.${region}.amazonaws.com/`, {
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': TARGET,
        },
        json: {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: clientId,
          AuthParameters: { USERNAME: username, PASSWORD: password },
        },
        responseType: 'json',
        throwHttpErrors: false,
      })
      .json<CognitoResponse>();
  } catch (e) {
    throw new Error(`Cognito did not respond: ${e instanceof Error ? e.message : String(e)}`);
  }

  const r = body.AuthenticationResult;
  if (!r?.AccessToken || !r?.IdToken) {
    // A pending challenge (password change, MFA) cannot be resolved here.
    const reason = body.ChallengeName
      ? `Cognito requires "${body.ChallengeName}" to be resolved before it issues a token`
      : body.message || body.__type || 'response without tokens';
    throw new Error(`Invalid auth response: ${reason}`);
  }
  return { idToken: r.IdToken, accessToken: r.AccessToken };
}

export async function awsCognito(authorization: string): Promise<BeforeRequestHook> {
  const [, username, password, region, userPoolId, clientId] = authorization.split(/\s+/);

  const { accessToken } = await login(username, password, region, userPoolId, clientId);

  return async (options) => {
    options.headers = {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
    };
  };
}
