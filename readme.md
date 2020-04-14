# file-backedup-session
Express session store using the file system and backing up to a Postgres database

# Usage
```javascript
import * as session from 'express-session';
const FileBackedUpSession = require('file-backedup-session')(session);

// optional logger
const debug = require('debug');
const log = debug('file-backedup-session:log');
log.error = debug('file-backedup-session:error');
log.debug = debug('file-backedup-session:debug');


app.use(session({
    store: new FileBackedUpSession({
        // required
        getSessions: getSessions, // () => Promise<{session_id: string, data: string}[]> // async function returning a sessions
        deleteSessions: deleteSessions, // [id: string] => Promise // async function that deletes the ids provided
        insertOrUpdateSession: insertOrUpdateSession, // (id: string, expires: number, data: string) => Promise // async function to inset or update session
        // optional
        setupBackup: setupBackup, // async function that sets up backup
        dir: 'sessions', // dir path to keep session files
        backupInterval: 60000, // the interval in which to update the database, in millis
        retryLimit: 100, // number of times to attempt to read a session before failure, negative for infinite
        retryWait: 100, // millis to wait before retrying
        log: log // logger in this shape
    })
}))
```