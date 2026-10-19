package dev.dragonscale.questbridge;

import net.minecraft.server.MinecraftServer;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.format.DateTimeFormatter;
import java.time.LocalDateTime;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Keeps a git history of the quest book.
 *
 * <p>Editing through the bridge is live, but live editing with no history is how a
 * book gets lost — which has already happened once on this server. Every change is
 * flushed to disk and committed, so there is always a way back.
 *
 * <p>Commits are debounced. One per keystroke would make the log useless; a few
 * seconds of quiet is about one commit per meaningful edit.
 *
 * <p>Shelling out to git rather than embedding a library: git is already on the
 * box, the repository is small, and a dependency inside a game server is a
 * liability.
 */
public final class GitHistory {
    private static final int DEBOUNCE_SECONDS = 8;
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final MinecraftServer mc;
    private final Path repo;          // config/ftbquests
    private final boolean enabled;
    private final ScheduledExecutorService worker =
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "questbridge-git");
            t.setDaemon(true);
            return t;
        });

    private final AtomicReference<ScheduledFuture<?>> pending = new AtomicReference<>();
    private final AtomicReference<String> summary = new AtomicReference<>("");
    private volatile boolean snapshotTaken = false;

    public GitHistory(MinecraftServer mc, Path questsRoot) {
        this.mc = mc;
        this.repo = questsRoot;
        this.enabled = init();
    }

    private boolean init() {
        try {
            if (!Files.isDirectory(repo)) {
                DragonscaleBridge.LOG.warn("[questbridge] no quest folder at {}; history disabled", repo);
                return false;
            }
            if (!Files.isDirectory(repo.resolve(".git"))) {
                if (run("init") != 0) return false;
                // LF, always: FTB writes with the host's convention and a Windows
                // client would otherwise rewrite every line of every file.
                Files.writeString(repo.resolve(".gitattributes"), "*.snbt text eol=lf\n");
                run("add", "-A");
                run("-c", "user.email=bridge@dragonscale", "-c", "user.name=Quest Bridge",
                    "commit", "-m", "Quest book as it stood when the bridge first ran");
                DragonscaleBridge.LOG.info("[questbridge] created a history repository at {}", repo);
            }
            return true;
        } catch (Exception e) {
            DragonscaleBridge.LOG.warn("[questbridge] history disabled: {}", e.toString());
            return false;
        }
    }

    /**
     * A copy taken before the first edit of a session, independent of the commit
     * loop — so there is a recovery path that does not depend on the thing that
     * might be broken.
     */
    private void snapshotOnce() {
        if (snapshotTaken) return;
        snapshotTaken = true;
        try {
            Path dest = repo.resolveSibling("ftbquests.before-" + LocalDateTime.now().format(STAMP));
            copyTree(repo.resolve("quests"), dest.resolve("quests"));
            DragonscaleBridge.LOG.info("[questbridge] session snapshot at {}", dest);
        } catch (Exception e) {
            DragonscaleBridge.LOG.warn("[questbridge] could not take a snapshot: {}", e.toString());
        }
    }

    /** Called after an applied batch. Resets the debounce window. */
    public void touched(String what) {
        if (!enabled) return;
        snapshotOnce();
        summary.set(what);
        ScheduledFuture<?> prev = pending.getAndSet(
            worker.schedule(this::commitNow, DEBOUNCE_SECONDS, TimeUnit.SECONDS));
        if (prev != null) prev.cancel(false);
    }

    private void commitNow() {
        try {
            // The book lives in memory; flush it before committing, on the server
            // thread, because writeDataFull walks FTB's live object graph.
            mc.submit(() -> BookReader.file().ifPresent(f -> f.saveNow())).get(30, TimeUnit.SECONDS);
        } catch (Exception e) {
            DragonscaleBridge.LOG.error("[questbridge] could not flush the book before committing", e);
            return;
        }
        try {
            if (run("add", "-A") != 0) return;
            int code = run("-c", "user.email=bridge@dragonscale", "-c", "user.name=Quest Bridge",
                "commit", "-m", summary.get().isBlank() ? "Quest edit" : summary.get());
            if (code == 0) {
                DragonscaleBridge.LOG.info("[questbridge] committed: {}", summary.get());
                // Push only if someone configured a remote; a missing one is normal.
                if (run("remote", "get-url", "origin") == 0) run("push", "--quiet");
            }
            // A non-zero code here is almost always "nothing to commit", which is
            // fine: an edit that changed nothing on disk needs no commit.
        } catch (Exception e) {
            DragonscaleBridge.LOG.error("[questbridge] commit failed", e);
        }
    }

    public void stop() {
        ScheduledFuture<?> p = pending.get();
        if (p != null && !p.isDone()) commitNow();     // do not lose the last edit
        worker.shutdownNow();
    }

    public boolean enabled() {
        return enabled;
    }

    // -------------------------------------------------------------- reading --

    /** One commit, as the editor lists it. */
    public record Entry(String id, String author, String when, String message) {}

    /**
     * The log, newest first. The format string separates fields with unit
     * separators rather than a punctuation character, because a commit message here
     * carries a quest title and a quest title can contain anything a person types.
     */
    public List<Entry> log(int limit) {
        List<Entry> out = new java.util.ArrayList<>();
        if (!enabled) return out;
        try {
            Result r = capture("log", "--max-count=" + Math.max(1, Math.min(limit, 500)),
                "--format=%H%x1f%an%x1f%aI%x1f%s");
            if (r.code() != 0) return out;
            for (String line : r.out().split("\n")) {
                String[] f = line.strip().split("\u001f", 4);
                if (f.length == 4) out.add(new Entry(f[0], f[1], f[2], f[3]));
            }
        } catch (Exception e) {
            DragonscaleBridge.LOG.warn("[questbridge] could not read the history: {}", e.toString());
        }
        return out;
    }

    /** The directory copies taken before the first edit of each session. */
    public List<String> snapshots() {
        List<String> out = new java.util.ArrayList<>();
        try (var list = Files.list(repo.getParent())) {
            list.map(p -> p.getFileName().toString())
                .filter(n -> n.startsWith("ftbquests.before-"))
                .sorted(java.util.Comparator.reverseOrder())
                .forEach(out::add);
        } catch (Exception ignored) {
            // The folder reads or it does not; an empty list is the right answer
            // either way, and the git log is the real history.
        }
        return out;
    }

    // ------------------------------------------------------------ restoring --

    /**
     * Puts the files back to a commit, without moving HEAD.
     *
     * <p>{@code read-tree -u --reset} is the operation that matches what restoring
     * means: make the working tree exactly that tree, deleting files added since,
     * where {@code checkout -- .} would leave them behind. Leaving HEAD alone means
     * the restore lands as a new commit on top of the history rather than rewriting
     * it, so undoing a restore is just another restore.
     *
     * <p>Two things happen first. The pending debounced commit is flushed, so the
     * state being replaced is itself in the history; and a directory copy is taken,
     * because this is the one operation here that can destroy a book and it should
     * not depend on the machinery it is undoing.
     */
    public synchronized void restore(String commit) throws Exception {
        if (!enabled) throw new IllegalStateException("no history for this folder");
        // This goes onto a command line. Nothing but a hash gets near it.
        if (!commit.matches("[0-9a-fA-F]{7,40}")) {
            throw new IllegalArgumentException("not a commit id: " + commit);
        }
        ScheduledFuture<?> p = pending.getAndSet(null);
        if (p != null) p.cancel(false);
        commitNow();                                   // the state we are leaving

        if (capture("cat-file", "-e", commit + "^{commit}").code() != 0) {
            throw new IllegalArgumentException("no such commit: " + commit);
        }
        snapshotTaken = false;
        snapshotOnce();                                // belt as well as braces

        Result r = capture("read-tree", "-u", "--reset", commit);
        if (r.code() != 0) throw new IOException("git read-tree failed: " + r.out().strip());
        DragonscaleBridge.LOG.warn("[questbridge] restored the quest folder to {}", commit);
    }

    /** Records the restore itself, once the server has re-read the files. */
    public void commitRestore(String commit) {
        summary.set("Restored to " + commit.substring(0, Math.min(8, commit.length())));
        worker.schedule(this::commitNow, 1, TimeUnit.SECONDS);
    }

    // -------------------------------------------------------------- helpers --

    private record Result(int code, String out) {}

    private int run(String... args) throws IOException, InterruptedException {
        return capture(args).code();
    }

    private Result capture(String... args) throws IOException, InterruptedException {
        List<String> cmd = new java.util.ArrayList<>(List.of("git"));
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd)
            .directory(repo.toFile())
            .redirectErrorStream(true)
            .start();
        String out = new String(p.getInputStream().readAllBytes());
        int code = p.waitFor();
        if (code != 0 && !out.contains("nothing to commit")) {
            DragonscaleBridge.LOG.debug("[questbridge] git {} -> {} {}", String.join(" ", args), code, out.strip());
        }
        return new Result(code, out);
    }

    private static void copyTree(Path from, Path to) throws IOException {
        if (!Files.isDirectory(from)) return;
        try (var walk = Files.walk(from)) {
            for (Path src : walk.toList()) {
                Path dst = to.resolve(from.relativize(src).toString());
                if (Files.isDirectory(src)) Files.createDirectories(dst);
                else {
                    Files.createDirectories(dst.getParent());
                    Files.copy(src, dst);
                }
            }
        }
    }
}
