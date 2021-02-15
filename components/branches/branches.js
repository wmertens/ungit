const ko = require('knockout');
const _ = require('lodash');
const octicons = require('octicons');
const components = require('ungit-components');
const programEvents = require('ungit-program-events');
const storage = require('ungit-storage');
const showRemote = 'showRemote';
const showBranch = 'showBranch';
const showTag = 'showTag';

components.register('branches', (args) => {
  return new BranchesViewModel(args.server, args.graph, args.repoPath);
});

class BranchesViewModel {
  constructor(server, graph, repoPath) {
    this.repoPath = repoPath;
    this.server = server;
    this.branchesAndLocalTags = ko.observableArray();
    this.current = ko.observable();
    this.isShowRemote = ko.observable(storage.getItem(showRemote) != 'false');
    this.isShowBranch = ko.observable(storage.getItem(showBranch) != 'false');
    this.isShowTag = ko.observable(storage.getItem(showTag) != 'false');
    this.graph = graph;
    const setLocalStorageAndUpdate = (localStorageKey, value) => {
      storage.setItem(localStorageKey, value);
      this.updateRefs();
      return value;
    };
    this.shouldAutoFetch = ungit.config.autoFetch;
    this.isShowRemote.subscribe(setLocalStorageAndUpdate.bind(null, showRemote));
    this.isShowBranch.subscribe(setLocalStorageAndUpdate.bind(null, showBranch));
    this.isShowTag.subscribe(setLocalStorageAndUpdate.bind(null, showTag));
    this.refsLabel = ko.computed(() => this.current() || 'master (no commits yet)');
    this.branchIcon = octicons['git-branch'].toSVG({ height: 18 });
    this.closeIcon = octicons.x.toSVG({ height: 18 });
    this.updateRefsDebounced = _.debounce(this.updateRefs, 500);
    this.updateRefsDebounced();
    this.updateRefsDebounced.flush();
    this.fetchedRefs = false;
  }

  checkoutBranch(branch) {
    branch.checkout();
  }
  updateNode(parentElement) {
    ko.renderTemplate('branches', this, {}, parentElement);
  }
  clickFetch() {
    this.updateRefs(true);
  }
  onProgramEvent(event) {
    if (
      event.event === 'working-tree-changed' ||
      event.event === 'request-app-content-refresh' ||
      event.event === 'branch-updated' ||
      event.event === 'git-directory-changed'
    ) {
      this.updateRefsDebounced();
    }
  }
  updateRefs(forceRemoteFetch) {
    forceRemoteFetch = forceRemoteFetch || this.shouldAutoFetch || '';
    if (!this.fetchedRefs) forceRemoteFetch = '';

    const currentBranchProm = this.server
      .getPromise('/checkout', { path: this.repoPath() })
      .then((branch) => this.current(branch))
      .catch((err) => this.current('~error'));

    // refreshes tags branches and remote branches
    const refsProm = this.server
      .getPromise('/refs', { path: this.repoPath(), remoteFetch: forceRemoteFetch })
      .then((refs) => {
        this.fetchedRefs = true;
        const version = Date.now();
        const refsById = {};
        this.graph.refsById = refsById;
        const sorted = refs
          .map(({ name, sha1 }) => {
            // !!! side effect: registers the ref
            const ref = this.graph.getRef(name.replace('refs/tags', 'tag: refs/tags'));
            if (!refsById[sha1]) refsById[sha1] = [];
            refsById[sha1].push(name);
            ref.version = version;
            ref.sha1 = sha1;
            return ref;
          })
          .filter(({ localRefName, isRemote, isBranch, isTag }) => {
            if (
              localRefName == 'refs/stash' ||
              // Remote HEAD
              localRefName.endsWith('/HEAD') ||
              (isRemote && !this.isShowRemote()) ||
              (isBranch && !this.isShowBranch()) ||
              (isTag && !this.isShowTag())
            )
              return false;
            return true;
          })
          .sort((a, b) => {
            if (a.current() || b.current()) {
              // Current branch is always first
              return a.current() ? -1 : 1;
            } else if (a.isRemoteBranch === b.isRemoteBranch) {
              // Otherwise, sort by name, grouped by remoteness
              return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
            } else {
              // Remote branches show last
              return a.isRemoteBranch ? 1 : -1;
            }
          });
        for (const ref of sorted) {
          // TODO showDanglingTags option
          const isImportant = !(ref.isRemoteTag || ref.isLocalTag);
          // These are the visible refs of the graph
          ref.node(this.graph.getNode(ref.sha1, null, isImportant));
        }
        this.branchesAndLocalTags(sorted);
        this.graph.refs().forEach((ref) => {
          // ref was removed from another source
          if (!ref.isRemoteTag && ref.value !== 'HEAD' && (!ref.version || ref.version < version)) {
            ref.remove(true);
          }
        });
        this.graph.loadNodesFromApiThrottled();
      })
      .catch((e) => this.server.unhandledRejection(e));

    return Promise.all([currentBranchProm, refsProm]);
  }

  branchRemove(branch) {
    let details = `"${branch.refName}"`;
    if (branch.isRemoteBranch) {
      details = `<code style='font-size: 100%'>REMOTE</code> ${details}`;
    }
    components
      .create('yesnodialog', {
        title: 'Are you sure?',
        details: 'Deleting ' + details + ' branch cannot be undone with ungit.',
      })
      .show()
      .closeThen((diag) => {
        if (!diag.result()) return;
        const url = `${branch.isRemote ? '/remote' : ''}/branches`;
        return this.server
          .delPromise(url, {
            path: this.graph.repoPath(),
            remote: branch.isRemote ? branch.remote : null,
            name: branch.refName,
          })
          .then(() => programEvents.dispatch({ event: 'working-tree-changed' }))
          .catch((e) => this.server.unhandledRejection(e));
      });
  }
}
