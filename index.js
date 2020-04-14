const util = require('util');
const fs = require('fs-extra');
const path = require('path');
const debug = require('debug');
const { diff, applyChange } = require('deep-diff');

module.exports = function(session) {
    const log = debug('file-backedup-session:log');
    log.error = debug('file-backedup-session:error');
    log.debug = debug('file-backedup-session:debug');

    function FileBackedUpSession(options) {
        this.options.log('init');
        this.options = {
            dir: 'sessions',
            backupInterval: 60000,
            retryLimit: 100,
            retryWait: 100,
            log: log,
            ...options
        };
        this.options.updatesPath = path.join(this.options.dir, 'updates');
        fs.mkdirs(this.options.dir);

        const loadSessions = () => {
            this.options.getSessions().then(sessions => {
                sessions.forEach(s => fs.outputFile(path.join(this.options.dir, s.session_id), s.data));
                this.options.log('init load sessions');
            }).catch(err => this.options.log.error(err));
        };

        if (this.options.setupBackup) {
            this.options.connection.setupBackup().then(() => {
                this.options.log('create table');
                loadSessions();
            }).catch(err => this.options.log.error(err));
        } else {
            loadSessions();
        }

        setInterval(() => this.backupSessions(), this.options.backupInterval);
    }

    FileBackedUpSession.prototype.all = function(cb) {
        fs.readdir(this.options.dir, (err, files) => {
            this.options.log('get all');
            files = files.filter(f => f != 'updates');
            Promise.all(files.map(id => this._get(id)))
                .then(sessions => {
                    sessions = sessions.reduce((acc, session, i) => {
                        acc[files[i]] = session;
                        return acc;
                    }, {});
                    for (const id in sessions) {
                        if (new Date(sessions[id].cookie.expires) < new Date()) {
                            this.destroy(id);
                            delete sessions[id];
                        }
                    }
                    return sessions;
                })
                .then(sessions => cb(null, sessions))
                .catch(cb);
        });
    }

    FileBackedUpSession.prototype.destroy = function(id, cb) {
        fs.remove(path.join(this.options.dir, id), err => {
            if (!err) this.addUpdated(id, true);
            this.options.log('destroy', id);
            cb && cb(err);
        });
    }

    FileBackedUpSession.prototype.clear = function(cb) {
        fs.readdir(this.options.dir, (err, files) => {
            this.options.log('clear all');
            files = files.filter(f => f != 'updates');
            Promise.all(files.map(id => new Promise(
                (resolve, reject) => this.destroy(id, err => err ? reject(err) : resolve())
            ))).then(() => cb(null)).catch(cb)
        });
    }

    FileBackedUpSession.prototype.length = function(cb) {
        this.options.log('length');
        fs.readdir(this.options.dir, (err, files) => cb(err, err || files.length));
    }

    FileBackedUpSession.prototype._get = async function(id, retries = this.options.retryLimit) {
        const sessionFile = path.join(this.options.dir, id);
        if (await fs.pathExists(sessionFile)) {
            try {
                return await fs.readJson(sessionFile);
            } catch (e) {
                if (
                    e.message
                    && e.message.match(/Unexpected.*JSON/)
                    && retries
                ) {
                    await new Promise(r => setTimeout(r, this.options.retryWait));
                    return this._get(id, --retries);
                }
                this.destroy(id);
                throw e;
            }
        }
    }

    FileBackedUpSession.prototype.get = function(id, cb) {
        this.options.log('get', id);
        this._get(id).then(s => {
            this.options.log.debug('get', id, s);
            if (s) s.ORIGINAL = JSON.parse((JSON.stringify(s)));
            cb(null, s);
        }).catch(cb);
    }

    FileBackedUpSession.prototype.set = function(id, session, cb) {
        const { ORIGINAL = {} } = session;
        delete session.ORIGINAL;
        const changes = diff(ORIGINAL, session);
        this._get(id).then((current = {}) => {
            delete current.ORIGINAL;
            changes.forEach(change => applyChange(current, true, change));
            fs.outputJson(path.join(this.options.dir, id), current, err => {
                if (!err) this.addUpdated(id);
                this.options.log('set', id);
                this.options.log.debug('set', id, session);
                cb(err);
            });
        }).catch(cb);
    }

    FileBackedUpSession.prototype.touch = function(id, _, cb) {
        this._get(id).then(session => {
            session.cookie.expires = new Date(Date.now() + session.cookie.originalMaxAge);
            fs.outputJson(path.join(this.options.dir, id), session, err => {
                if (!err) this.addUpdated(id);
                this.options.log('touch', id);
                this.options.log.debug('touch', id, session);
                cb(err);
            });
        }).catch(cb);
    }

    FileBackedUpSession.prototype.addUpdated = async function(id, removed = false) {
        let updates = {mod: [], removed: []};
        if (await fs.pathExists(this.options.updatesPath))
            try {
                updates = await fs.readJson(this.options.updatesPath);
            } catch (e) {}
        const list = updates[removed ? 'removed' : 'mod'];
        if (!list.includes(id)) {
            if (id) list.push(id);
            fs.writeJson(this.options.updatesPath, updates);
        }
        this.options.log('updates', updates);
    }

    FileBackedUpSession.prototype.backupSessions = async function() {
        if (await fs.pathExists(this.options.updatesPath)) {
            let updates;
            try {
                updates = await fs.readJson(this.options.updatesPath);
            } catch (e) {
                return;
            }
            this.options.log('update db', updates);
            fs.remove(this.options.updatesPath);
            if (updates.removed && updates.removed.length)  {
                this.options.deleteSessions(updates.removed).catch(err => this.options.log.error(err));
            }
            this.all((err, sessions) => {
                if (err) {
                    this.options.log.error(err);
                    throw err;
                }
                updates.mod.filter(id => sessions[id]).forEach(id => {
                    const session = sessions[id];
                    delete session.ORIGINAL;
                    const expires = ((new Date(session.cookie.expires) / 1000) | 0).toString();
                    this.options.insertOrUpdateSession(id, expires, JSON.stringify(session)).catch(err => this.options.log.error(err));
                });
            });
        }
    }

    util.inherits(FileBackedUpSession, session.Store);
   
    return FileBackedUpSession;
};
