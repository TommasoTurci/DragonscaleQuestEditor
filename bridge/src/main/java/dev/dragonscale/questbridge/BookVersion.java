package dev.dragonscale.questbridge;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Monotonic counter bumped on every applied change, however it arrived — the web
 * editor, a player editing in game, or a restore.
 *
 * <p>Clients send the version they last saw with an edit; a stale one is rejected
 * rather than applied, so a client that fell behind re-syncs instead of silently
 * overwriting someone else's work.
 */
public final class BookVersion {
    private static final AtomicLong VERSION = new AtomicLong(1);

    private BookVersion() {}

    public static long current() {
        return VERSION.get();
    }

    public static long bump() {
        return VERSION.incrementAndGet();
    }
}
