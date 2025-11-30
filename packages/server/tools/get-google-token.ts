/**
 * Helper script to get Google OAuth refresh token
 *
 * Prerequisites:
 * 1. Create OAuth 2.0 credentials at https://console.cloud.google.com/apis/credentials
 * 2. Set application type to "Desktop app"
 * 3. Download the JSON credentials file
 *
 * Usage:
 *   npx ts-node tools/get-google-token.ts <client_id> <client_secret>
 *
 * This will:
 * 1. Open a browser for authentication
 * 2. Print the refresh token to use with Secret Manager
 */

import { google } from 'googleapis';
import * as http from 'http';
import * as url from 'url';

const SCOPES = ['https://www.googleapis.com/auth/tasks'];
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

async function getRefreshToken(clientId: string, clientSecret: string): Promise<void> {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n========================================');
  console.log('Google OAuth Setup');
  console.log('========================================\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in and grant access to Google Tasks');
  console.log('3. The refresh token will be displayed here\n');

  // Start local server to receive callback
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/oauth2callback')) {
      const parsedUrl = url.parse(req.url, true);
      const code = parsedUrl.query.code as string;

      if (code) {
        try {
          const { tokens } = await oauth2Client.getToken(code);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Success!</h1><p>You can close this window.</p>');

          console.log('========================================');
          console.log('SUCCESS! Here is your refresh token:');
          console.log('========================================\n');
          console.log(tokens.refresh_token);
          console.log('\n========================================');
          console.log('Save this token in Secret Manager as:');
          console.log('google-tasks-refresh-token');
          console.log('========================================\n');

          server.close();
          process.exit(0);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error getting token');
          console.error('Error:', error);
          server.close();
          process.exit(1);
        }
      }
    }
  });

  server.listen(3000, () => {
    console.log('Waiting for OAuth callback on http://localhost:3000 ...\n');
  });
}

// Main
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.log('Usage: npx ts-node tools/get-google-token.ts <client_id> <client_secret>');
  console.log('\nTo get these values:');
  console.log('1. Go to https://console.cloud.google.com/apis/credentials');
  console.log('2. Create OAuth 2.0 Client ID (Desktop app type)');
  console.log('3. Use the Client ID and Client Secret from there');
  process.exit(1);
}

getRefreshToken(args[0], args[1]).catch(console.error);
