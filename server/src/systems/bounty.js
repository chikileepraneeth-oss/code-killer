// Bounty target: every 60s (after grace) one living player is marked for 30s.
import { BOUNTY } from '../../../shared/constants.js';
import { rollItem } from '../../../shared/items.js';

export const bountySystem = {
  updateBounty(now) {
    const g = this.game;
    if (now < g.graceUntil) return;
    if (g.bounty && now >= g.bounty.until) {
      const b = this.players.get(g.bounty.id);
      g.bounty = null;
      if (b && b.alive) {
        const item = rollItem();
        this.giveItem(b, item, now);
        this.send(b.id, 'announce', { type: 'bountySurvivedYou', item });
        this.broadcast('announce', { type: 'bountySurvived', name: b.name, color: b.color }, (q) => q.id !== b.id);
      }
    }
    if (!g.bounty && now >= g.nextBountyAt) this.pickBounty(now);
    // Pending reward choices expire -> default to a shuffle
    for (const p of this.players.values()) {
      if (p.pendingReward && now >= p.pendingReward.until) this.chooseReward(p.id, 'shuffle', now);
    }
  },

  pickBounty(now) {
    const g = this.game;
    const living = [...this.players.values()].filter((p) => p.alive && !p.spectator);
    g.nextBountyAt = now + BOUNTY.INTERVAL;
    if (living.length < 2) return null;
    const pool = living.length > 2 ? living.filter((p) => p.id !== g.lastBountyId) : living;
    const b = pool[Math.floor(Math.random() * pool.length)];
    g.bounty = { id: b.id, until: now + BOUNTY.DURATION };
    g.lastBountyId = b.id;
    this.broadcast('announce', { type: 'bounty', id: b.id, name: b.name, color: b.color, ms: BOUNTY.DURATION });
    return b;
  },

  onBountyEnded(victim, killer, cause, now) {
    const g = this.game;
    g.bounty = null;
    if (cause === 'kill' && killer && killer.alive) {
      killer.bountiesClaimed = (killer.bountiesClaimed || 0) + 1;
      killer.pendingReward = { until: now + BOUNTY.CHOICE_MS };
      if (killer.isBot) this.chooseReward(killer.id, 'shuffle', now);
      else this.send(killer.id, 'bounty:reward', { ms: BOUNTY.CHOICE_MS });
    }
  },

  /** Reward for claiming a bounty: 'reveal' (see your own code for 5s) or 'shuffle'. */
  chooseReward(id, choice, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || !p.pendingReward || !this.game) return { ok: false };
    p.pendingReward = null;
    if (!p.alive) return { ok: false };
    if (choice === 'reveal') {
      // The one deliberate exception to "never send a player their own code".
      this.send(p.id, 'you:selfCode', { code: p.code, ms: BOUNTY.REVEAL_MS });
      return { ok: true, choice: 'reveal' };
    }
    this.shuffleCode(p, now);
    return { ok: true, choice: 'shuffle' };
  },
};
