package dev.dragonscale.questbridge;

import dev.ftb.mods.ftbquests.quest.ServerQuestFile;

/**
 * Notices edits made in game.
 *
 * <p>The point of the bridge is two people editing at once — one in the quest book
 * on the server, one in the web app — and that only works if changes travel both
 * ways. Changes made through {@code /api/edit} announce themselves. Changes made in
 * game do not: FTB fires no event when a quest object is edited, and its
 * {@code markDirty} only sets a private flag.
 *
 * <p>So the book is fingerprinted and compared. Two things keep that cheap rather
 * than wasteful:
 *
 * <ul>
 * <li>It only runs while somebody has the editor open. With nobody connected the
 *     watcher costs one branch per tick, and it refingerprints on the first tick
 *     after someone arrives rather than reporting everything they missed as one
 *     spurious change.
 * <li>The fingerprint is retaken immediately after the bridge's own edits, on the
 *     same thread, so our own changes are never rediscovered and announced twice.
 * </ul>
 */
public final class BookWatch {
    /** Two seconds: fast enough to feel live, slow enough to be invisible. */
    private static final int EVERY_TICKS = 40;

    private long digest;
    private int ticks;
    private boolean cold = true;

    /**
     * Records the book as it stands, so the next poll sees no change. Called after
     * the bridge applies its own edits, on the server thread.
     */
    public void sync(ServerQuestFile f) {
        digest = BookReader.digest(f);
        cold = false;
    }

    /**
     * Runs on the server thread. True when the book changed underneath us, which
     * means somebody edited it in game.
     */
    public boolean poll(boolean anyoneWatching) {
        if (!anyoneWatching) {
            cold = true;              // resync before judging the next change
            return false;
        }
        if (++ticks < EVERY_TICKS) return false;
        ticks = 0;

        var file = BookReader.file();
        if (file.isEmpty()) return false;
        if (cold) {
            sync(file.get());
            return false;
        }
        long now = BookReader.digest(file.get());
        if (now == digest) return false;
        digest = now;
        return true;
    }
}
