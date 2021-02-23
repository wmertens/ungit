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
const { getRepo, initGit, quickStatus } = require('./nodegit');

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
  // app.all('*', (q, r, n) => console.log(q.method, q.path, q.query, q.body) || n());

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
              // TODO emit ref changes individually
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

  const ensurePathExists = async (req, res, next) => {
    try {
      const path = req.query.path || req.body.path;
      req.repo = await getRepo(path);
      next();
    } catch (err) {
      res.status(400).json({ error: err.message, errorCode: err.errorCode || 'no-such-path' });
    }
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

  /** @typedef {{ repo?: import('./nodegit').NGWrap; body: any; params: any; query: any }} Req */

  const w = (/** @type {(req:Req, res:any) => any} */ fn) => (req, res) =>
    new Promise((resolve) => resolve(fn(req, res))).catch((err) => {
      winston.warn('Responding with ERROR: ', err);
      res.status(500).json(err);
    });

  const jw = (/** @type {(req:Req, res:any) => any} */ fn) => (req, res) =>
    jsonResultOrFailProm(res, new Promise((resolve) => resolve(fn(req, res))));

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

  const autoStash = async (repo, fn) => {
    if (config.autoStashAndPop) {
      const oid = await repo.addStash('Ungit: automatic stash').catch((err) => {
        // Nothing to save
        if (err.errno === -3) return;
        throw err;
      });
      const out = await fn();
      await repo.popStash(oid);
      return out;
    } else {
      return fn();
    }
  };

  app.get(
    `${exports.pathPrefix}/status`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => req.repo.status())
  );

  app.post(
    `${exports.pathPrefix}/init`,
    ensureAuthenticated,
    jw((req) => initGit(req.body.path, req.body.bare))
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
    jw(async (req, res) => {
      // Allow a little longer timeout on fetch (10min)
      if (res.setTimeout) res.setTimeout(tenMinTimeoutMs);
      const { path, ref, remote } = req.body;
      await req.repo
        .remoteFetch(remote, ref ? [ref] : null, config.autoPruneOnFetch)
        .finally(() => emitGitDirectoryChanged(path));
    })
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
      await autoStash(req.repo, () =>
        gitPromise(['reset', `--${req.body.mode}`, req.body.to], repoPath)
      );
      await emitGitDirectoryChanged(repoPath);
      await emitWorkingTreeChanged(repoPath);
      const head = await req.repo.getHead();
      return head.sha1;
    })
  );

  app.get(`${exports.pathPrefix}/diff`, ensureAuthenticated, ensurePathExists, (req, res) => {
    const { path, file, oldFile, patchNum: pn, sha1, whiteSpace } = req.query;
    const patchNum = pn && pn !== true ? getNumber(pn, -1) : -1;
    jsonResultOrFailProm(
      res,
      sha1 && patchNum >= 0
        ? req.repo.diffFile({ sha1, patchNum, ignoreWhiteSpace: whiteSpace === 'true' })
        : gitPromise.diffFile(path, file || oldFile, oldFile || file, sha1, whiteSpace === 'true')
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
      const { all, path, file } = req.body;
      const task = all
        ? gitPromise.discardAllChanges(path)
        : gitPromise.discardChangesInFile(path, file.trim());
      jsonResultOrFailProm(
        res,
        task.finally(() => emitWorkingTreeChanged(path))
      );
    }
  );

  app.post(
    `${exports.pathPrefix}/ignorefile`,
    ensureAuthenticated,
    ensurePathExists,
    (req, res) => {
      const { path, file } = req.body;
      const gitIgnoreFile = `${path}/.gitignore`;
      const task = fs
        .appendFile(gitIgnoreFile, os.EOL + file)
        .catch((err) => {
          throw {
            errorCode: 'error-appending-ignore',
            error: 'Error while appending to .gitignore file.',
          };
        })
        .finally(() => emitWorkingTreeChanged(path));

      jsonResultOrFailProm(res, task);
    }
  );

  app.post(`${exports.pathPrefix}/commit`, ensureAuthenticated, ensurePathExists, (req, res) => {
    const { path, amend, emptyCommit, message, files } = req.body;
    jsonResultOrFailProm(
      res,
      gitPromise.commit(path, amend, emptyCommit, message, files).finally(() => {
        emitGitDirectoryChanged(path);
        emitWorkingTreeChanged(path);
      })
    );
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
    `${exports.pathPrefix}/commits`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      let { limit, ids } = req.query;
      limit = getNumber(limit, config.numberOfNodesPerLoad || 25);
      ids = typeof ids === 'string' && ids ? ids.split(',') : [];
      if (!ids.length) return [];
      const nodes = await req.repo.log(limit, 0, ids);
      return nodes;
    })
  );

  app.get(
    `${exports.pathPrefix}/gitlog`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const limit = getNumber(req.query.limit, config.numberOfNodesPerLoad || 25);
      const skip = getNumber(req.query.skip, 0);
      const nodes = await req.repo.log(limit, skip, config.maxActiveBranchSearchIteration);
      return { skip: skip + nodes.length, nodes, isHeadExist: true };
    })
  );

  // app.get(
  //   `${exports.pathPrefix}/show`,
  //   ensureAuthenticated,
  //   jw((req) =>
  //     gitPromise(['show', '--numstat', '-z', req.query.sha1], req.query.path).then(
  //       gitParser.parseGitLog
  //     )
  //   )
  // );

  app.get(
    `${exports.pathPrefix}/head`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => req.repo.getHead())
  );

  app.get(
    `${exports.pathPrefix}/refs`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req, res) => {
      if (req.query.remoteFetch) {
        if (res.setTimeout) res.setTimeout(tenMinTimeoutMs);
        await req.repo.remoteAllFetch().catch((err) => {
          console.warn('ignoring fetch error', err);
        });
      }

      return req.repo.refs();
    })
  );

  // Unused
  // app.get(
  //   `${exports.pathPrefix}/branches`,
  //   ensureAuthenticated,
  //   ensurePathExists,
  //   jw((req) => {
  //     const isLocalBranchOnly = req.query.isLocalBranchOnly == 'false';
  //     return gitPromise(['branch', isLocalBranchOnly ? '-a' : ''], req.query.path).then(
  //       gitParser.parseGitBranches
  //     );
  //   })
  // );

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
    jw(async (req) => req.repo.getTags())
  );

  app.get(
    `${exports.pathPrefix}/remote/tags`,
    ensureAuthenticated,
    ensurePathExists,
    ensureValidSocketId,
    jw((req) => req.repo.remoteFetchTags(req.query.remote))
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
    jw(async (req) =>
      req.repo.deleteTag(req.query.name).finally(() => emitGitDirectoryChanged(req.query.path))
    )
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
        return await autoStash(req.repo, () => gitPromise(arg, repoPath));
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
      await autoStash(req.repo, () => gitPromise(['cherry-pick', req.body.name.trim()], repoPath));
      await emitGitDirectoryChanged(repoPath);
      await emitWorkingTreeChanged(repoPath);
    })
  );

  app.get(
    `${exports.pathPrefix}/checkout`,
    ensureAuthenticated,
    ensurePathExists,
    jw((req) => req.repo.getCurrentBranch())
  );

  app.get(
    `${exports.pathPrefix}/remotes`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => await req.repo.getRemotes())
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
    jw(async (req) => req.repo.addRemote(req.params.name, req.body.url))
  );

  app.delete(
    `${exports.pathPrefix}/remotes/:name`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => req.repo.deleteRemote(req.params.name))
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
    jw(async (req) => {
      const currentPath = path.resolve(path.join(req.query.path, '..'));
      const stat = await quickStatus(currentPath);
      if (stat.type === 'no-such-path' || stat.type === 'uninited') return {};
      return { path: stat.gitRootPath };
    })
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
    jw(async (req) => quickStatus(req.query.path))
  );

  app.get(
    `${exports.pathPrefix}/stashes`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => req.repo.getStashes())
  );

  app.post(
    `${exports.pathPrefix}/stashes`,
    ensureAuthenticated,
    ensurePathExists,
    jw(async (req) => {
      const { path: repoPath, message = '' } = req.body;
      const oid = await req.repo.addStash(message);
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
      try {
        if (apply === 'true') {
          await req.repo.applyStash(index);
        } else {
          await req.repo.deleteStash(index);
        }
      } finally {
        await emitGitDirectoryChanged(repoPath);
        await emitWorkingTreeChanged(repoPath);
      }
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
