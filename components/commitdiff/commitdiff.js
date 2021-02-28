const ko = require('knockout');
const CommitLineDiff = require('./commitlinediff.js').CommitLineDiff;
const components = require('ungit-components');

components.register('commitDiff', (args) => new CommitDiff(args));

class CommitDiff {
  constructor(args) {
    this.commitLineDiffs = ko.observableArray();
    this.diffKey = args.diffKey;

    this.showDiffButtons = args.showDiffButtons;
    this.textDiffType = args.textDiffType = args.textDiffType || components.create('textdiff.type');
    this.wordWrap = args.wordWrap = args.wordWrap || components.create('textdiff.wordwrap');
    this.whiteSpace = args.whiteSpace = args.whiteSpace || components.create('textdiff.whitespace');

    this.loadFileLineDiffs(args);
  }

  updateNode(parentElement) {
    ko.renderTemplate('commitdiff', this, {}, parentElement);
  }

  loadFileLineDiffs(args) {
    if (!args.fileLineDiffs) return;
    const lines = args.fileLineDiffs;

    this.commitLineDiffs(
      this.commitLineDiffs().concat(
        lines.map((fileLineDiff) => new CommitLineDiff(args, fileLineDiff))
      )
    );
  }
}
