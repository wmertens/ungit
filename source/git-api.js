const path = require('path');
const temp = require('temp');
const gitParser = require('./git-parser');
const winston = require('winston');
const os = require('os');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const _ = require('lodash');
const gitPromise = require('./git-promise');
const fs = require('fs').promises;
const watch = require('fs').watch;
const ignore = require('ignore');
const nodegit = require('nodegit');
const fileType = require('./utils/file-type.js');

const isMac = /^darwin/.test(process.platform);
const isWindows = /^win/.test(process.platform);
const tenMinTimeoutMs = 10 * 60 * 1000;

exports.pathPrefix = '';

exports.registerApi = (env) => {
  const app = env.app;
  const ensureAuthenticated = env.ensureAuthenticated || ((req, res, next) => next());
  const config = env.config;
  const io = env.socketIO;
  const socketsById = env.socketsById || {};

  if (config.dev) temp.track();

  if (io) {
    io.on('connection', (socket) => {
      socket.on('disconnect', () => {
        stopDirectoryWatch(socket);
      });
      socket.on('watch', (data, callback) => {
        stopDirectoryWatch(socket); // clean possibly lingering connections
        socket.watcherPath = path.normalize(data.path);
        socket.join(socket.watcherPath); // join room for this path

        fs.readFile(path.join(socket.watcherPath, '.gitignore'))
          .then((ignoreContent) => (socket.ignore = ignore().add(ignoreContent.toString())))
          .catch(() => {})
          .then(() => {
            socket.watcher = [];
            return watchPath(socket, '.', { recursive: isMac || isWindows });
          })
          .then(() => {
            if (!isMac && !isWindows) {
              // recursive fs.watch only works on mac and windows
              const promises = [];
              promises.push(watchPath(socket, path.join('.git', 'HEAD')));
              promises.push(watchPath(socket, path.join('.git', 'refs', 'heads')));
              promises.push(watchPath(socket, path.join('.git', 'refs', 'remotes')));
              promises.push(watchPath(socket, path.join('.git', 'refs', 'tags')));
              return Promise.all(promises);
            }
          })
          .finally(callback);
      });
    });
  }

  const watchPath = (socket, subfolderPath, options) => {
    const pathToWatch = path.join(socket.watcherPath, subfolderPath);
    winston.info(`Start watching ${pathToWatch}`);
    return fs
      .access(pathToWatch)
      .catch(() => {
        // Sometimes necessary folders, '.../.git/refs/heads' and etc, are not created on git init
        winston.debug(`intended folder to watch doesn't exists, creating: ${pathToWatch}`);
        return mkdirp(pathToWatch);
      })
      .then(() => {
        const watcher = watch(pathToWatch, options || {});
        watcher.on('change', (event, filename) => {
          if (!filename) return;
          const filePath = path.join(subfolderPath, filename);
          winston.debug(`File change: ${filePath}`);
          if (isFileWatched(filePath, socket.ignore)) {
            winston.info(`${filePath} triggered refresh for ${socket.watcherPath}`);
            emitGitDirectoryChanged(socket.watcherPath);
            emitWorkingTreeChanged(socket.watcherPath);
          }
        });
        watcher.on('error', (err) => {
          winston.warn(`Error watching ${pathToWatch}: `, JSON.stringify(err));
        });
        socket.watcher.push(watcher);
      });
  };

  const stopDirectoryWatch = (socket) => {
    socket.leave(socket.watcherPath);
    socket.ignore = undefined;
    (socket.watcher || []).forEach((watcher) => watcher.close());
    winston.info(`Stop watching ${socket.watcherPath}`);
  };

  // The .git dir changes on for instance 'git status', so we
  // can't trigger a change here (since that would lead to an endless
  // loop of the client getting the change and then requesting the new data)
  const isFileWatched = (filename, ignore) => {
    if (ignore && ignore.filter(filename).length == 0) {
      return false; // ignore files that are in .gitignore
    } else if (filename.endsWith('.lock')) {
      return false;
    } else if (filename.indexOf(path.join('.git', 'refs')) > -1) {
      return true; // trigger for all changes under refs
    } else if (filename == path.join('.git', 'HEAD')) {
      return true; // Explicitly return true for ".git/HEAD" for branch changes
    } else if (filename.indexOf('.git') > -1) {
      return false; // Ignore other changes under ".git/*"
    } else {
      return true;
    }
  };

  const ensurePathExists = (req, res, next) => {
    fs.access(req.query.path || req.body.path)
      .then(() => {
        next();
      })
      .catch(() => {
        res.status(400).json({ error: `'No such path: ${path}`, errorCode: 'no-such-path' });
      });
  };

  const ensureValidSocketId = (req, res, next) => {
    const socketId = req.query.socketId || req.body.socketId;
    if (socketId == 'ignore') return next(); // Used in unit tests
    const socket = socketsById[socketId];
    if (!socket) {
      res
        .status(400)
        .json({ error: `No such socket: ${socketId}`, errorCode: 'invalid-socket-id' });
    } else {
      next();
    }
  };

  const emitWorkingTreeChanged = _.debounce(
    (repoPath) => {
      if (io && repoPath) {
        io.in(path.normalize(repoPath)).emit('working-tree-changed', { repository: repoPath });
        winston.info('emitting working-tree-changed to sockets, manually triggered');
      }
    },
    500,
    { maxWait: 2000 }
  );
  const emitGitDirectoryChanged = _.debounce(
    (repoPath) => {
      if (io && repoPath) {
        io.in(path.normalize(repoPath)).emit('git-directory-changed', { repository: repoPath });
        winston.info('emitting git-directory-changed to sockets, manually triggered');
      }
    },
    500,
    { maxWait: 2000 }
  );

  // from libgit2/include/git2/errors.h
  const nodegitErrors = {
    '-1': 'GIT_ERROR', // Generic error
    '-3': 'GIT_ENOTFOUND', // Requested object could not be found
    '-4': 'GIT_EEXISTS', // Object exists preventing operation
    '-5': 'GIT_EAMBIGUOUS', // More than one object matches
    '-6': 'GIT_EBUFS', // Output buffer too short to hold data
    /*
     * GIT_EUSER is a special error that is never generated by libgit2
     * code.  You can return it from a callback (e.g to stop an iteration)
     * to know that it was generated by the callback and not by libgit2.
     */
    '-7': 'GIT_EUSER',

    '-8': 'GIT_EBAREREPO', // Operation not allowed on bare repository
    '-9': 'GIT_EUNBORNBRANCH', // HEAD refers to branch with no commits
    '-10': 'GIT_EUNMERGED', // Merge in progress prevented operation
    '-11': 'GIT_ENONFASTFORWARD', // Reference was not fast-forwardable
    '-12': 'GIT_EINVALIDSPEC', // Name/ref spec was not in a valid format
    '-13': 'GIT_ECONFLICT', // Checkout conflicts prevented operation
    '-14': 'GIT_ELOCKED', // Lock file prevented operation
    '-15': 'GIT_EMODIFIED', // Reference value does not match expected
    '-16': 'GIT_EAUTH', // Authentication error
    '-17': 'GIT_ECERTIFICATE', // Server certificate is invalid
    '-18': 'GIT_EAPPLIED', // Patch/merge has already been applied
    '-19': 'GIT_EPEEL', // The requested peel operation is not possible
    '-20': 'GIT_EEOF', // Unexpected EOF
    '-21': 'GIT_EINVALID', // Invalid operation or input
    '-22': 'GIT_EUNCOMMITTED', // Uncommitted changes in index prevented operation
    '-23': 'GIT_EDIRECTORY', // The operation is not valid for a directory
    '-24': 'GIT_EMERGECONFLICT', // A merge conflict exists and cannot continue

    '-30': 'GIT_PASSTHROUGH', // A user-configured callback refused to act
    '-31': 'GIT_ITEROVER', // Signals end of iteration with iterator
    '-32': 'GIT_RETRY', // Internal only
    '-33': 'GIT_EMISMATCH', // Hashsum mismatch in object
    '-34': 'GIT_EINDEXDIRTY', // Unsaved changes in the index would be overwritten
    '-35': 'GIT_EAPPLYFAIL', // Patch application failed
  };
  const normalizeError = (err) => {
    console.error('normalizing', err);
    if (!err.errorCode && err.errno) err.errorCode = nodegitErrors[err.errno];
    throw err;
  };

  const repoPs = {};
  /**
   * Memoize nodegit opened repos.
   *
   * @param {string} repoPath  The path to the repository.
   * @returns {Promise<nodegit.Repository>}
   */
  const getRepo = (repoPath) => {
    if (!repoPs[repoPath]) {
      repoPs[repoPath] = nodegit.Repository.open(repoPath).catch((err) => {
        repoPs[repoPath] = false;
        normalizeError(err);
      });
    }
    return repoPs[repoPath];
  };

  const autoStash = async (repoPath, fn) => {
    if (config.autoStashAndPop) {
      const repo = await getRepo(repoPath);
      const signature = await repo.defaultSignature();
      const oid = await nodegit.Stash.save(
        repo,
        signature,
        'Ungit: automatic stash',
        nodegit.Stash.FLAGS.INCLUDE_UNTRACKED
      ).catch((err) => {
        // Nothing to save
        if (err.errno === -3) return;
        normalizeError(err);
      });
      const out = await fn();
      if (!oid) return out;
      let index;
      await nodegit.Stash.foreach(repo, (i, _msg, stashOid) => {
        if (stashOid.equal(oid)) index = i;
      }).catch(normalizeError);
      if (index != null) {
        await nodegit.Stash.pop(repo, index, {
          flags: nodegit.Stash.APPLY_FLAGS.APPLY_REINSTATE_INDEX,
        }).catch(normalizeError);
      }
      return out;
    } else {
      return fn();
    }
  };

  /** @param {nodegit.Commit} c */
  const formatCommit = (c) => ({
    commitDate: c.date().toJSON(),
    message: c.message(),
    sha1: c.sha(),
  });

  /** @param {nodegit.Commit} c */
  const getFileStats = async (c) => {
    const diffList = await c.getDiff();
    // Each diff has the entire patch set for some reason
    const patches = await (diffList[0] && diffList[0].patches());
    if (!(patches && patches.length)) return [];

    return patches.map((patch) => {
      const stats = patch.lineStats();
      const oldFileName = patch.oldFile().path();
      const displayName = patch.newFile().path();
      return /** @type {gitParser.FileStatus} */ ({
        additions: stats.total_additions,
        deletions: stats.total_deletions,
        fileName: displayName,
        oldFileName,
        displayName,
        // TODO figure out how to get this
        type: fileType(displayName),
      });
    });
  };

  const jsonResultOrFailProm = (res, promise) => {
    const now = Date.now();
    return promise
      .then((o) => {
        const elapsed = Date.now() - now;
        res.header('X-elapsed', elapsed);
        // TODO shouldn't this be a boolean instead of an object?
        return res.json(o == null ? {} : o);
      })
      .catch((err) => {
        winston.warn('Responding with ERROR: ', JSON.stringify(err));
        res.status(400).json(err);
      });
  };

  const w = (fn) => (req, res) =>
    new Promise((resolve) => resolve(fn(req, res))).catch((err) => {
      winston.warn('Responding with ERROR: ', err);
      res.status(500).json(err);
    });

  const jw = (fn) => (req, res) =>
    jsonResultOrFailProm(res, new Promise((resolve) => resolve(fn(req))));

  const credentialsOption = (socketId, remote) => {
    let portAndRootPath = `${config.port}`;
    if (config.rootPath) {
      portAndRootPath = `${config.port}${config.rootPath}`;
    }
    const credentialsHelperPath = path
      .resolve(__dirname, '..', 'bin', 'credentials-helper')
      .replace(/\\/g, '/');
    return [
      '-c',
      `credential.helper=${credentialsHelperPath} ${socketId} ${portAndRootPath} ${remote}`,
    ];
  };

  const getNumber = (value, nullValue) => {
    const finalValue = parseInt(value ? value : nullValue);
    if (finalValue || finalValue === 0) {
      return finalValue;
    } else {
      throw { error: 'invalid number' };
    }
  };

  app.get(
    `${exports.pathPrefix}/status`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => gitPromise.status(req.query.path, null))
  );

  app.post(
    `${exports.pathPrefix}/init`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => {
      var path = req.body.path;
      // nodegit requires a number https://github.com/nodegit/nodegit/issues/538
      var is_bare = req.body.bare ? 1 : 0;
      return nodegit.Repository.init(path, is_bare).catch(normalizeError);
    })
  );

  app.post(
    `${exports.pathPrefix}/clone`,
    ensureAuthenticated,
    ensurePathExists,
    ensureValidSocketId,
    w((req, res) => {
      // Default timeout is 2min but clone can take much longer than that (allows up to 2h)
      const timeoutMs = 2 * 60 * 60 * 1000;
      if (res.setTimeout) res.setTimeout(timeoutMs);

      let url = req.body.url.trim();
      if (url.indexOf('git clone ') == 0) url = url.slice('git clone '.length);

      const commands = ['clone', url, req.body.destinationDir.trim()];
      if (req.body.isRecursiveSubmodule) {
        commands.push('--recurse-submodules');
      }

      const task = gitPromise({
        commands: credentialsOption(req.body.socketId, url).concat(commands),
        repoPath: req.body.path,
        timeout: timeoutMs,
      }).then(() => {
        return { path: path.resolve(req.body.path, req.body.destinationDir) };
      });

      jsonResultOrFailProm(res, task).finally(emitGitDirectoryChanged.bind(null, req.body.path));
    })
  );

  app.post(
    `${exports.pathPrefix}/fetch`,
    ensureAuthenticated,
    ensurePathExists,
    ensureValidSocketId,
    (req, res) => {
      // Allow a little longer timeout on fetch (10min)
      if (res.setTimeout) res.setTimeout(tenMinTimeoutMs);

      const task = gitPromise({
        commands: credentialsOption(req.body.socketId, req.body.remote).concat([
          'fetch',
          req.body.remote,
          req.body.ref ? req.body.ref : '',
          config.autoPruneOnFetch ? '--prune' : '',
        ]),
        repoPath: req.body.path,
        timeout: tenMinTimeoutMs,
      });

      jsonResultOrFailProm(res, task).finally(emitGitDirectoryChanged.bind(null, req.body.path));
    }
  );

  app.post(
    `${exports.pathPrefix}/push`,
    ensureAuthenticated,
    ensurePathExists,
    ensureValidSocketId,
    (req, res) => {
      // Allow a little longer timeout on push (10min)
      if (res.setTimeout) res.setTimeout(tenMinTimeoutMs);
      const task = gitPromise({
        commands: credentialsOption(req.body.socketId, req.body.remote).concat([
          'push',
          req.body.remote,
          (req.body.refSpec ? req.body.refSpec : 'HEAD') +
            (req.body.remoteBranch ? `:${req.body.remoteBranch}` : ''),
          req.body.force ? '-f' : '',
        ]),
        repoPath: req.body.path,
        timeout: tenMinTimeoutMs,
      });

      jsonResultOrFailProm(res, task).finally(emitGitDirectoryChanged.bind(null, req.body.path));
    }
  );

  app.post(
    `${exports.pathPrefix}/reset`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const repoPath = req.body.path;
      await autoStash(repoPath, () =>
        gitPromise(['reset', `--${req.body.mode}`, req.body.to], repoPath)
      );
      await emitGitDirectoryChanged(repoPath);
      await emitWorkingTreeChanged(repoPath);
    })
  );

  app.get(`${exports.pathPrefix}/diff`, ensureAuthenticated, ensurePathExists, (req, res) => {
    const isIgnoreWhiteSpace = req.query.whiteSpace === 'true' ? true : false;
    jsonResultOrFailProm(
      res,
      gitPromise.diffFile(
        req.query.path,
        req.query.file,
        req.query.oldFile,
        req.query.sha1,
        isIgnoreWhiteSpace
      )
    );
  });

  app.get(`${exports.pathPrefix}/diff/image`, ensureAuthenticated, ensurePathExists, (req, res) => {
    res.type(path.extname(req.query.filename));
    if (req.query.version !== 'current') {
      gitPromise.binaryFileContent(req.query.path, req.query.filename, req.query.version, res);
    } else {
      res.sendFile(path.join(req.query.path, req.query.filename));
    }
  });

  app.post(
    `${exports.pathPrefix}/discardchanges`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const task = req.body.all
        ? gitPromise.discardAllChanges(req.body.path)
        : gitPromise.discardChangesInFile(req.body.path, req.body.file.trim());
      jsonResultOrFailProm(res, task.then(emitWorkingTreeChanged.bind(null, req.body.path)));
    }
  );

  app.post(
    `${exports.pathPrefix}/ignorefile`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const currentPath = req.body.path.trim();
      const gitIgnoreFile = `${currentPath}/.gitignore`;
      const ignoreFile = req.body.file.trim();
      const task = fs.appendFile(gitIgnoreFile, os.EOL + ignoreFile).catch((err) => {
        throw {
          errorCode: 'error-appending-ignore',
          error: 'Error while appending to .gitignore file.',
        };
      });

      jsonResultOrFailProm(res, task).finally(emitWorkingTreeChanged.bind(null, req.body.path));
    }
  );

  app.post(`${exports.pathPrefix}/commit`, ensureAuthenticated, ensurePathExists, (req, res) => {
    jsonResultOrFailProm(
      res,
      gitPromise.commit(
        req.body.path,
        req.body.amend,
        req.body.emptyCommit,
        req.body.message,
        req.body.files
      )
    )
      .then(emitGitDirectoryChanged.bind(null, req.body.path))
      .then(emitWorkingTreeChanged.bind(null, req.body.path));
  });

  app.post(`${exports.pathPrefix}/revert`, ensureAuthenticated, ensurePathExists, (req, res) => {
    const task = gitPromise(['revert', req.body.commit], req.body.path).catch((e) => {
      if (e.message.indexOf('is a merge but no -m option was given.') > 0) {
        return gitPromise(['revert', '-m', 1, req.body.commit], req.body.path);
      } else {
        throw e;
      }
    });
    jsonResultOrFailProm(res, task)
      .finally(emitGitDirectoryChanged.bind(null, req.body.path))
      .finally(emitWorkingTreeChanged.bind(null, req.body.path));
  });

  app.get(
    `${exports.pathPrefix}/gitlog`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => {
      const limit = getNumber(req.query.limit, config.numberOfNodesPerLoad || 25);
      const skip = getNumber(req.query.skip, 0);
      return gitPromise
        .log(req.query.path, limit, skip, config.maxActiveBranchSearchIteration)
        .catch((err) => {
          if (err.stderr && err.stderr.indexOf("fatal: bad default revision 'HEAD'") == 0) {
            return { limit: limit, skip: skip, nodes: [] };
          } else if (
            /fatal: your current branch '.+' does not have any commits yet.*/.test(err.stderr)
          ) {
            return { limit: limit, skip: skip, nodes: [] };
          } else if (err.stderr && err.stderr.indexOf('fatal: Not a git repository') == 0) {
            return { limit: limit, skip: skip, nodes: [] };
          } else {
            throw err;
          }
        });
    })
  );

  app.get(
    `${exports.pathPrefix}/show`,
    ensureAuthenticated,
    jw((req) =>
      gitPromise(['show', '--numstat', '-z', req.query.sha1], req.query.path).then(
        gitParser.parseGitLog
      )
    )
  );

  app.get(
    `${exports.pathPrefix}/head`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) =>
      gitPromise(
        ['log', '--decorate=full', '--pretty=fuller', '-z', '--parents', '--max-count=1'],
        req.query.path
      )
        .then(gitParser.parseGitLog)
        .catch((err) => {
          if (err.stderr.indexOf("fatal: bad default revision 'HEAD'") == 0) return [];
          else if (
            /fatal: your current branch '.+' does not have any commits yet.*/.test(err.stderr)
          )
            return [];
          else if (err.stderr.indexOf('fatal: Not a git repository') == 0) return [];
          throw err;
        })
    )
  );

  app.get(`${exports.pathPrefix}/refs`, ensureAuthenticated, ensurePathExists, (req, res) => {
    if (res.setTimeout) res.setTimeout(tenMinTimeoutMs);

    let task = Promise.resolve();
    if (req.query.remoteFetch) {
      task = task.then(() =>
        gitPromise(['remote'], req.query.path).then((remoteText) => {
          const remotes = remoteText.trim().split('\n');

          // making calls serially as credential helpers may get confused to which cred to get.
          return remotes.reduce((promise, remote) => {
            if (!remote || remote === '') return promise;
            return promise.then(() => {
              return gitPromise({
                commands: credentialsOption(req.query.socketId, remote).concat(['fetch', remote]),
                repoPath: req.query.path,
                timeout: tenMinTimeoutMs,
              }).catch((e) => winston.warn('err during remote fetch for /refs', e)); // ignore fetch err as it is most likely credential
            });
          }, Promise.resolve());
        })
      );
    }
    task = task
      .then(() => gitPromise(['show-ref', '-d'], req.query.path))
      // On new fresh repos, empty string is returned but has status code of error, simply ignoring them
      .catch((e) => {
        if (e.message !== '') throw e;
      })
      .then((refs) => {
        const results = [];
        if (refs) {
          refs
            .trim()
            .split('\n')
            .forEach((n) => {
              const splitted = n.split(' ');
              const sha1 = splitted[0];
              const name = splitted[1];
              if (name.indexOf('refs/tags') > -1 && name.indexOf('^{}') > -1) {
                results[results.length - 1].sha1 = sha1;
              } else {
                results.push({
                  name: name,
                  sha1: sha1,
                });
              }
            });
        }
        return results;
      });
    jsonResultOrFailProm(res, task);
  });

  app.get(
    `${exports.pathPrefix}/branches`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => {
      const isLocalBranchOnly = req.query.isLocalBranchOnly == 'false';
      return gitPromise(['branch', isLocalBranchOnly ? '-a' : ''], req.query.path).then(
        gitParser.parseGitBranches
      );
    })
  );

  app.post(
    `${exports.pathPrefix}/branches`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => {
      const commands = [
        'branch',
        req.body.force ? '-f' : '',
        req.body.name.trim(),
        (req.body.sha1 || 'HEAD').trim(),
      ];

      return gitPromise(commands, req.body.path).finally(
        emitGitDirectoryChanged.bind(null, req.body.path)
      );
    })
  );

  app.delete(
    `${exports.pathPrefix}/branches`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) =>
      gitPromise(['branch', '-D', req.query.name.trim()], req.query.path).finally(
        emitGitDirectoryChanged.bind(null, req.query.path)
      )
    )
  );

  app.delete(
    `${exports.pathPrefix}/remote/branches`,
    ensureAuthenticated,
    ensurePathExists,
    ensureValidSocketId,
    (req, res) => {
      const commands = credentialsOption(req.query.socketId, req.query.remote).concat([
        'push',
        req.query.remote,
        `:${req.query.name.trim()}`,
      ]);
      const task = gitPromise(commands, req.query.path).catch((err) => {
        if (!(err.stderr && err.stderr.indexOf('remote ref does not exist') > -1)) {
          throw err;
        }
      });

      jsonResultOrFailProm(res, task).finally(emitGitDirectoryChanged.bind(null, req.query.path));
    }
  );

  app.get(
    `${exports.pathPrefix}/tags`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const repoPath = req.query.path;
      const repo = await getRepo(repoPath);
      return nodegit.Tag.list(repo).catch(normalizeError);
    })
  );

  app.get(
    `${exports.pathPrefix}/remote/tags`,
    ensureAuthenticated,
    ensurePathExists,
    ensureValidSocketId,
    (req, res) => {
      const task = gitPromise(
        credentialsOption(req.query.socketId, req.query.remote).concat([
          'ls-remote',
          '--tags',
          req.query.remote,
        ]),
        req.query.path
      )
        .then(gitParser.parseGitLsRemote)
        .then((result) => {
          result.forEach((r) => {
            r.remote = req.query.remote;
          });
          return result;
        });
      jsonResultOrFailProm(res, task);
    }
  );

  app.post(`${exports.pathPrefix}/tags`, ensureAuthenticated, ensurePathExists, (req, res) => {
    const annotateFlag = config.isForceGPGSign ? '-s' : '-a';
    const forceFlag = req.body.force ? '-f' : '';
    const sha1 = (req.body.sha1 || 'HEAD').trim();
    const commands = [
      'tag',
      forceFlag,
      annotateFlag,
      req.body.name.trim(),
      '-m',
      req.body.name.trim(),
      sha1,
    ];

    jsonResultOrFailProm(res, gitPromise(commands, req.body.path)).finally(
      emitGitDirectoryChanged.bind(null, req.body.path)
    );
  });

  app.delete(
    `${exports.pathPrefix}/tags`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const repoPath = req.query.path;
      const tagName = req.query.name.trim();
      const repo = await getRepo(repoPath);
      return nodegit.Tag.delete(repo, tagName)
        .catch(normalizeError)
        .finally(() => emitGitDirectoryChanged(repoPath));
    })
  );

  app.delete(
    `${exports.pathPrefix}/remote/tags`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const commands = credentialsOption(req.query.socketId, req.query.remote).concat([
        'push',
        req.query.remote,
        `:refs/tags/${req.query.name.trim()}`,
      ]);
      const task = gitPromise(['tag', '-d', req.query.name.trim()], req.query.path)
        .catch(() => {}) // might have already deleted, so ignoring error
        .then(() => gitPromise(commands, req.query.path));

      jsonResultOrFailProm(res, task).finally(emitGitDirectoryChanged.bind(null, req.query.path));
    }
  );

  app.post(
    `${exports.pathPrefix}/checkout`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const arg = req.body.sha1
        ? ['checkout', '-b', req.body.name.trim(), req.body.sha1]
        : ['checkout', req.body.name.trim()];
      const repoPath = req.body.path;
      try {
        return await autoStash(repoPath, () => gitPromise(arg, repoPath));
      } finally {
        await emitGitDirectoryChanged(repoPath);
        await emitWorkingTreeChanged(repoPath);
      }
    })
  );

  app.post(
    `${exports.pathPrefix}/cherrypick`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const repoPath = req.body.path;
      await autoStash(repoPath, () => gitPromise(['cherry-pick', req.body.name.trim()], repoPath));
      await emitGitDirectoryChanged(repoPath);
      await emitWorkingTreeChanged(repoPath);
    })
  );

  app.get(`${exports.pathPrefix}/checkout`, ensureAuthenticated, ensurePathExists, (req, res) => {
    jsonResultOrFailProm(res, gitPromise.getCurrentBranch(req.query.path));
  });

  app.get(
    `${exports.pathPrefix}/remotes`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const repoPath = req.query.path;
      const repo = await getRepo(repoPath);
      return nodegit.Remote.list(repo).catch(normalizeError);
    })
  );

  app.get(
    `${exports.pathPrefix}/remotes/:name`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      jsonResultOrFailProm(res, gitPromise.getRemoteAddress(req.query.path, req.params.name));
    }
  );

  app.post(
    `${exports.pathPrefix}/remotes/:name`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const name = req.params.name;
      const url = req.body.url;
      const repoPath = req.body.path;
      const repo = await getRepo(repoPath);
      return nodegit.Remote.create(repo, name, url).catch(normalizeError);
    })
  );

  app.delete(
    `${exports.pathPrefix}/remotes/:name`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const name = req.params.name;
      const repoPath = req.body.path;
      const repo = await getRepo(repoPath);
      return nodegit.Remote.delete(repo, name).catch(normalizeError);
    })
  );

  app.post(`${exports.pathPrefix}/merge`, ensureAuthenticated, ensurePathExists, (req, res) => {
    jsonResultOrFailProm(
      res,
      gitPromise(['merge', config.noFFMerge ? '--no-ff' : '', req.body.with.trim()], req.body.path)
    )
      .finally(emitGitDirectoryChanged.bind(null, req.body.path))
      .finally(emitWorkingTreeChanged.bind(null, req.body.path));
  });

  app.post(
    `${exports.pathPrefix}/merge/continue`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const args = {
        commands: ['commit', '--file=-'],
        repoPath: req.body.path,
        inPipe: req.body.message,
      };

      jsonResultOrFailProm(res, gitPromise(args))
        .finally(emitGitDirectoryChanged.bind(null, req.body.path))
        .finally(emitWorkingTreeChanged.bind(null, req.body.path));
    }
  );

  app.post(
    `${exports.pathPrefix}/merge/abort`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      jsonResultOrFailProm(res, gitPromise(['merge', '--abort'], req.body.path))
        .finally(emitGitDirectoryChanged.bind(null, req.body.path))
        .finally(emitWorkingTreeChanged.bind(null, req.body.path));
    }
  );

  app.post(`${exports.pathPrefix}/squash`, ensureAuthenticated, ensurePathExists, (req, res) => {
    jsonResultOrFailProm(
      res,
      gitPromise(['merge', '--squash', req.body.target.trim()], req.body.path)
    )
      .finally(emitGitDirectoryChanged.bind(null, req.body.path))
      .finally(emitWorkingTreeChanged.bind(null, req.body.path));
  });

  app.post(`${exports.pathPrefix}/rebase`, ensureAuthenticated, ensurePathExists, (req, res) => {
    jsonResultOrFailProm(res, gitPromise(['rebase', req.body.onto.trim()], req.body.path))
      .finally(emitGitDirectoryChanged.bind(null, req.body.path))
      .finally(emitWorkingTreeChanged.bind(null, req.body.path));
  });

  app.post(
    `${exports.pathPrefix}/rebase/continue`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      jsonResultOrFailProm(res, gitPromise(['rebase', '--continue'], req.body.path))
        .finally(emitGitDirectoryChanged.bind(null, req.body.path))
        .finally(emitWorkingTreeChanged.bind(null, req.body.path));
    }
  );

  app.post(
    `${exports.pathPrefix}/rebase/abort`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      jsonResultOrFailProm(res, gitPromise(['rebase', '--abort'], req.body.path))
        .finally(emitGitDirectoryChanged.bind(null, req.body.path))
        .finally(emitWorkingTreeChanged.bind(null, req.body.path));
    }
  );

  app.post(
    `${exports.pathPrefix}/resolveconflicts`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      winston.info('resolve conflicts');
      jsonResultOrFailProm(res, gitPromise.resolveConflicts(req.body.path, req.body.files)).then(
        emitWorkingTreeChanged.bind(null, req.body.path)
      );
    }
  );

  app.post(
    `${exports.pathPrefix}/launchmergetool`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const commands = [
        'mergetool',
        ...(typeof req.body.tool === 'string' ? ['--tool ', req.body.tool] : []),
        '--no-prompt',
        req.body.file,
      ];
      gitPromise(commands, req.body.path);
      // Send immediate response, this is because merging may take a long time
      // and there is no need to wait for it to finish.
      res.json({});
    }
  );

  app.get(
    `${exports.pathPrefix}/baserepopath`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const currentPath = path.resolve(path.join(req.query.path, '..'));
      jsonResultOrFailProm(
        res,
        gitPromise(['rev-parse', '--show-toplevel'], currentPath)
          .then((baseRepoPath) => {
            return { path: path.resolve(baseRepoPath.trim()) };
          })
          .catch((e) => {
            if (e.errorCode === 'not-a-repository' || e.errorCode === 'must-be-in-working-tree') {
              // not a repository or a bare repository
              return {};
            }
            throw e;
          })
      );
    }
  );

  app.get(`${exports.pathPrefix}/submodules`, ensureAuthenticated, ensurePathExists, (req, res) => {
    const filename = path.join(req.query.path, '.gitmodules');

    const task = fs
      .access(filename)
      .then(() => {
        return fs.readFile(filename, { encoding: 'utf8' }).then(gitParser.parseGitSubmodule);
      })
      .catch(() => {
        return {};
      });
    jsonResultOrFailProm(res, task);
  });

  app.post(
    `${exports.pathPrefix}/submodules/update`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      jsonResultOrFailProm(
        res,
        gitPromise(['submodule', 'init'], req.body.path).then(
          gitPromise.bind(null, ['submodule', 'update'], req.body.path)
        )
      );
    }
  );

  app.post(
    `${exports.pathPrefix}/submodules/add`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      jsonResultOrFailProm(
        res,
        gitPromise(
          ['submodule', 'add', req.body.submoduleUrl.trim(), req.body.submodulePath.trim()],
          req.body.path
        )
      )
        .finally(emitGitDirectoryChanged.bind(null, req.body.path))
        .finally(emitWorkingTreeChanged.bind(null, req.body.path));
    }
  );

  app.delete(
    `${exports.pathPrefix}/submodules`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      // -f is needed for the cases when added submodule change is not in the staging or committed
      const task = gitPromise(
        ['submodule', 'deinit', '-f', req.query.submoduleName],
        req.query.path
      )
        .then(gitPromise.bind(null, ['rm', '-f', req.query.submoduleName], req.query.path))
        .then(() => {
          rimraf.sync(path.join(req.query.path, req.query.submodulePath));
          rimraf.sync(path.join(req.query.path, '.git', 'modules', req.query.submodulePath));
        });

      jsonResultOrFailProm(res, task);
    }
  );

  app.get(
    `${exports.pathPrefix}/quickstatus`,
    ensureAuthenticated,
    jw(async (req) => {
      const repoPath = path.normalize(req.query.path);
      try {
        const repo = await getRepo(repoPath);
        if (repo.isBare()) return { type: 'bare', gitRootPath: repo.path().replace(/\/$/, '') };
        return { type: 'inited', gitRootPath: repo.workdir().replace(/\/$/, '') };
      } catch (err) {
        if (err.message.includes('No such')) return { type: 'no-such-path', gitRootPath: repoPath };
        return { type: 'uninited', gitRootPath: repoPath };
      }
    })
  );

  app.get(
    `${exports.pathPrefix}/stashes`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const repo = await getRepo(req.query.path);
      const oids = [];
      await nodegit.Stash.foreach(repo, (index, message, oid) => {
        oids.push(oid);
      }).catch(normalizeError);
      const stashes = await Promise.all(oids.map((oid) => repo.getCommit(oid)));
      return Promise.all(
        stashes.map(async (stash, index) => ({
          ...formatCommit(stash),
          reflogId: `${index}`,
          reflogName: `stash@{${index}}`,
          fileLineDiffs: await getFileStats(stash),
        }))
      );
    })
  );

  app.post(
    `${exports.pathPrefix}/stashes`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const { path: repoPath, message = '' } = req.body;
      const repo = await getRepo(repoPath);
      const signature = await repo.defaultSignature();
      const oid = await nodegit.Stash.save(
        repo,
        signature,
        message,
        nodegit.Stash.FLAGS.INCLUDE_UNTRACKED
      ).catch(normalizeError);
      await emitGitDirectoryChanged(repoPath);
      await emitWorkingTreeChanged(repoPath);
      return oid;
    })
  );

  app.delete(
    `${exports.pathPrefix}/stashes/:id`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const { path: repoPath, apply } = req.query;
      const { id } = req.params;
      const index = Number(id);
      if (isNaN(index) || index < 0) throw new Error(`Invalid index ${id}`);
      const repo = await getRepo(repoPath);
      if (apply === 'true') {
        await nodegit.Stash.apply(repo, index).catch(normalizeError);
      } else {
        await nodegit.Stash.drop(repo, index).catch(normalizeError);
      }
      await emitGitDirectoryChanged(repoPath);
      await emitWorkingTreeChanged(repoPath);
    })
  );

  app.get(`${exports.pathPrefix}/gitconfig`, ensureAuthenticated, (req, res) => {
    jsonResultOrFailProm(res, gitPromise(['config', '--list']).then(gitParser.parseGitConfig));
  });

  // This method isn't called by the client but by credentials-helper.js
  app.get(`${exports.pathPrefix}/credentials`, (req, res) => {
    // this endpoint can only be invoked from localhost, since the credentials-helper is always
    // on the same machine that we're running ungit on
    if (req.ip != '127.0.0.1' && req.ip != '::ffff:127.0.0.1') {
      winston.info(`Trying to get credentials from unathorized ip: ${req.ip}`);
      res.status(400).json({ errorCode: 'request-from-unathorized-location' });
      return;
    }
    const socket = socketsById[req.query.socketId];
    const remote = req.query.remote;
    if (!socket) {
      // We're using the socket to display an authentication dialog in the ui,
      // so if the socket is closed/unavailable we pretty much can't get the username/password.
      winston.info(`Trying to get credentials from unavailable socket: ${req.query.socketId}`);
      res.status(400).json({ errorCode: 'socket-unavailable' });
    } else {
      socket.once('credentials', (data) => res.json(data));
      socket.emit('request-credentials', { remote: remote });
    }
  });

  app.post(`${exports.pathPrefix}/createdir`, ensureAuthenticated, (req, res) => {
    const dir = req.query.dir || req.body.dir;
    if (!dir) {
      return res.status(400).json({
        errorCode: 'missing-request-parameter',
        error: 'You need to supply the path request parameter',
      });
    }

    mkdirp(dir)
      .then(() => res.json({}))
      .catch((err) => res.status(400).json(err));
  });

  app.get(`${exports.pathPrefix}/gitignore`, ensureAuthenticated, ensurePathExists, (req, res) => {
    fs.readFile(path.join(req.query.path, '.gitignore'))
      .then((ignoreContent) => res.status(200).json({ content: ignoreContent.toString() }))
      .catch((e) => {
        if (e && e.message && e.message.indexOf('no such file or directory') > -1) {
          res.status(200).json({ content: '' });
        } else {
          res.status(500).json(e);
        }
      });
  });
  app.put(`${exports.pathPrefix}/gitignore`, ensureAuthenticated, ensurePathExists, (req, res) => {
    if (!req.body.data && req.body.data !== '') {
      return res.status(400).json({ message: 'Invalid .gitignore content' });
    }
    fs.writeFile(path.join(req.body.path, '.gitignore'), req.body.data)
      .then(() => res.status(200).json({}))
      .finally(emitGitDirectoryChanged.bind(null, req.body.path))
      .catch((e) => res.status(500).json(e));
  });

  if (config.dev) {
    app.post(`${exports.pathPrefix}/testing/createtempdir`, ensureAuthenticated, (req, res) => {
      temp.mkdir('test-temp-dir', (err, tempPath) => res.json({ path: path.normalize(tempPath) }));
    });
    app.post(`${exports.pathPrefix}/testing/createfile`, ensureAuthenticated, (req, res) => {
      const content = req.body.content ? req.body.content : `test content\n${Math.random()}\n`;
      fs.writeFile(req.body.file, content)
        .then(() => res.json({}))
        .then(emitWorkingTreeChanged.bind(null, req.body.path));
    });
    app.post(`${exports.pathPrefix}/testing/changefile`, ensureAuthenticated, (req, res) => {
      const content = req.body.content ? req.body.content : `test content\n${Math.random()}\n`;
      fs.writeFile(req.body.file, content)
        .then(() => res.json({}))
        .then(emitWorkingTreeChanged.bind(null, req.body.path));
    });
    app.post(`${exports.pathPrefix}/testing/createimagefile`, ensureAuthenticated, (req, res) => {
      fs.writeFile(req.body.file, 'png', { encoding: 'binary' })
        .then(() => res.json({}))
        .then(emitWorkingTreeChanged.bind(null, req.body.path));
    });
    app.post(`${exports.pathPrefix}/testing/changeimagefile`, ensureAuthenticated, (req, res) => {
      fs.writeFile(req.body.file, 'png ~~', { encoding: 'binary' })
        .then(() => res.json({}))
        .then(emitWorkingTreeChanged.bind(null, req.body.path));
    });
    app.post(`${exports.pathPrefix}/testing/removefile`, ensureAuthenticated, (req, res) => {
      fs.unlink(req.body.file)
        .then(() => res.json({}))
        .then(emitWorkingTreeChanged.bind(null, req.body.path));
    });
    app.post(`${exports.pathPrefix}/testing/git`, ensureAuthenticated, (req, res) => {
      jsonResultOrFailProm(res, gitPromise(req.body.command, req.body.path)).then(
        emitWorkingTreeChanged.bind(null, req.body.path)
      );
    });
    app.post(`${exports.pathPrefix}/testing/cleanup`, (req, res) => {
      temp.cleanup((err, cleaned) => {
        winston.info('Cleaned up: ' + JSON.stringify(cleaned));
        res.json({ result: cleaned });
      });
    });
  }
};
