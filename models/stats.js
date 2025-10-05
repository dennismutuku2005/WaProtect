class SpamStats {
  constructor() {
    this.stats = {
      totalProcessed: 0,
      localFlagged: 0,
      geminiAnalyzed: 0,
      messagesDeleted: 0,
      usersRemoved: 0,
      warningsSent: 0
    };
  }

  increment(stat) {
    if (this.stats[stat] !== undefined) {
      this.stats[stat]++;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  reset() {
    this.stats = {
      totalProcessed: 0,
      localFlagged: 0,
      geminiAnalyzed: 0,
      messagesDeleted: 0,
      usersRemoved: 0,
      warningsSent: 0
    };
  }
}

module.exports = new SpamStats();