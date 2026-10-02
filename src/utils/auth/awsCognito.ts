import got from 'got';
import type { BeforeRequestHook } from 'got';

/**
 * Autenticación con AWS Cognito.
 *
 * La implementación original importaba `aws-amplify` entero —GraphQL, DataStore,
 * predicciones de aprendizaje automático, pubsub, notificaciones— para hacer un
 * inicio de sesión: 17 MB en disco y 41 paquetes con vulnerabilidades conocidas.
 *
 * Cognito es una API HTTP normal, así que aquí se llama directamente. Mismo
 * comportamiento, misma sintaxis en el fichero `.http`, sin el SDK.
 */

const OBJETIVO = 'AWSCognitoIdentityProviderService.InitiateAuth';

interface RespuestaCognito {
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
  let body: RespuestaCognito;
  try {
    body = await got
      .post(`https://cognito-idp.${region}.amazonaws.com/`, {
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': OBJETIVO,
        },
        json: {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: clientId,
          AuthParameters: { USERNAME: username, PASSWORD: password },
        },
        responseType: 'json',
        throwHttpErrors: false,
      })
      .json<RespuestaCognito>();
  } catch (e) {
    throw new Error(`Cognito no respondió: ${e instanceof Error ? e.message : String(e)}`);
  }

  const r = body.AuthenticationResult;
  if (!r?.AccessToken || !r?.IdToken) {
    // Un desafío pendiente (cambio de contraseña, MFA) no se puede resolver aquí.
    const motivo = body.ChallengeName
      ? `Cognito pide resolver "${body.ChallengeName}" antes de dar un token`
      : body.message || body.__type || 'respuesta sin tokens';
    throw new Error(`Invalid auth response: ${motivo}`);
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
