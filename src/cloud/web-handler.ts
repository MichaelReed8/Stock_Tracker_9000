import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { json, securityHeaders, summaryApi, type WebEvent } from './web-api.js';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
const verifier = () => CognitoJwtVerifier.create({ userPoolId: process.env.USER_POOL_ID!, tokenUse: 'access', clientId: process.env.USER_POOL_CLIENT_ID! });
let jwt: ReturnType<typeof verifier> | undefined;
const assets: Record<string, string> = { '/': 'text/html; charset=utf-8', '/app.js': 'text/javascript', '/app.css': 'text/css', '/icon.svg': 'image/svg+xml', '/icon.png': 'image/png', '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript' };

export async function handler(event: WebEvent) {
  try {
    if (event.rawPath === '/api/config' && event.requestContext.http.method === 'GET') return json(200, { region: process.env.AWS_REGION, clientId: process.env.USER_POOL_CLIENT_ID });
    if (event.rawPath.startsWith('/api/')) return await summaryApi(event,
      async (pk, sk) => (await db.send(new GetCommand({ TableName: process.env.DATA_TABLE, Key: { pk, sk }, ConsistentRead: true }))).Item,
      token => (jwt ??= verifier()).verify(token));
    if (!['GET', 'HEAD'].includes(event.requestContext.http.method)) return json(405, { error: 'method_not_allowed' });
    const type = assets[event.rawPath];
    if (!type) return json(404, { error: 'not_found' });
    const name = event.rawPath === '/' ? 'index.html' : event.rawPath.slice(1);
    const body = await readFile(join(import.meta.dirname, 'web', name));
    return { statusCode: 200, headers: { ...securityHeaders, 'content-type': type, 'cache-control': event.rawPath === '/' || event.rawPath === '/sw.js' ? 'no-cache' : 'public, max-age=300' }, isBase64Encoded: true, body: event.requestContext.http.method === 'HEAD' ? '' : body.toString('base64') };
  } catch {
    console.error('Web request failed'); // Never log request headers, tokens, raw SDK errors or user input.
    return json(503, { error: 'temporarily_unavailable' });
  }
}
