import { google } from 'googleapis';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
dotenv.config();

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob' // desktop app redirect
);

const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ]
});

console.log('Open this URL in your browser:\n', url);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nPaste the code here: ', async (code) => {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\nYour refresh token:\n', tokens.refresh_token);
    console.log('\nAdd this to your .env as GOOGLE_OAUTH_REFRESH_TOKEN');
    rl.close();
});