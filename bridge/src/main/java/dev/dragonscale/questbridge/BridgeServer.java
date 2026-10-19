package dev.dragonscale.questbridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.server.MinecraftServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Properties;
import java.util.concurrent.Executors;

/**
 * The HTTP surface. Deliberately built on the JDK's own server rather than a
 * framework: this runs inside a game server, and every dependency added here is a
 * dependency that can clash with a mod.
 */
public final class BridgeServer {
    private static final int BACKLOG = 0;

    private final MinecraftServer mc;
    private final int port;
    private final String token;
    private final String bind;
    private HttpServer http;
    private final ChangeFeed feed = new ChangeFeed();
    private final BookWatch watch = new BookWatch();
    private static final Gson GSON = new Gson();
    private GitHistory history;

    public BridgeServer(MinecraftServer mc) throws IOException {
        this.mc = mc;
        Path cfg = mc.getServerDirectory().resolve("config").resolve("questbridge.properties");
        Properties p = loadOrCreate(cfg);
        this.port = Integer.parseInt(p.getProperty("port", "25580"));
        this.token = p.getProperty("token", "");
        // Loopback by default. This server has a public IP, and the bridge speaks
        // plain HTTP: bound to 0.0.0.0 the token crosses the internet in the clear
        // on every request. Widen it only behind TLS or a tunnel.
        this.bind = p.getProperty("bind", "127.0.0.1");
    }

    /**
     * The token is generated on first run rather than defaulted, so an unconfigured
     * install is never left open. It is a dev server, but it is on the internet.
     */
    private static Properties loadOrCreate(Path cfg) throws IOException {
        Properties p = new Properties();
        if (Files.exists(cfg)) {
            try (var in = Files.newInputStream(cfg)) {
                p.load(in);
            }
            if (!p.getProperty("token", "").isBlank()) return p;
        }
        byte[] buf = new byte[24];
        new SecureRandom().nextBytes(buf);
        p.setProperty("port", p.getProperty("port", "25580"));
        p.setProperty("bind", p.getProperty("bind", "127.0.0.1"));
        p.setProperty("token", HexFormat.of().formatHex(buf));
        Files.createDirectories(cfg.getParent());
        try (var out = Files.newOutputStream(cfg)) {
            p.store(out, "Dragonscale Quest Bridge. Keep the token secret; it grants edit access to the quest book.");
        }
        DragonscaleBridge.LOG.info("[questbridge] wrote a new config with a generated token: {}", cfg);
        return p;
    }

    public void start() throws IOException {
        http = HttpServer.create(new InetSocketAddress(bind, port), BACKLOG);
        http.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        // API: token required.
        http.createContext("/api/health", authed(this::health));
        http.createContext("/api/book", authed(this::book));
        http.createContext("/api/types", authed(this::types));
        http.createContext("/api/changes", authed(feed::subscribe));
        http.createContext("/api/edit", authed(this::edit));

        // The editor and its icons. No token: the shell is not secret, the data is.
        Path web = mc.getServerDirectory().resolve("config").resolve("questbridge");
        http.createContext("/icons/", new StaticFiles(web.resolve("icons"), "/questbridge/icons", "/icons", false));
        http.createContext("/", new StaticFiles(web.resolve("www"), "/questbridge/www", "", true));
        history = new GitHistory(mc, mc.getServerDirectory().resolve("config").resolve("ftbquests"));
        http.start();
        DragonscaleBridge.LOG.info("[questbridge] listening on {}:{}", bind, port);
    }

    /**
     * Called every server tick. Cheap while nobody has the editor open; see
     * {@link BookWatch}.
     */
    public void tick() {
        if (!watch.poll(feed.count() > 0)) return;
        JsonObject change = new JsonObject();
        change.addProperty("version", BookVersion.bump());
        change.addProperty("source", "game");
        feed.publish(change);
        if (history != null) history.touched("Edited in game");
    }

    public void stop() {
        feed.stop();
        if (history != null) history.stop();
        if (http != null) {
            http.stop(1);
            DragonscaleBridge.LOG.info("[questbridge] stopped");
        }
    }

    // ------------------------------------------------------------- handlers --

    /**
     * The write path. Edits are applied on the server thread as one batch, and only
     * if the client has seen the current version — a stale client re-syncs rather
     * than overwriting whatever it missed.
     */
    private void edit(HttpExchange x) throws IOException {
        if (!"POST".equals(x.getRequestMethod())) {
            send(x, 405, "{\"error\":\"POST only\"}");
            return;
        }
        var file = BookReader.file();
        if (file.isEmpty()) {
            send(x, 503, "{\"error\":\"quest file not loaded yet\"}");
            return;
        }

        JsonObject body;
        try {
            body = JsonParser.parseString(
                new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (Exception e) {
            send(x, 400, "{\"error\":\"body is not JSON\"}");
            return;
        }

        long base = body.has("baseVersion") ? body.get("baseVersion").getAsLong() : -1;
        if (base >= 0 && base != BookVersion.current()) {
            send(x, 409, "{\"error\":\"stale\",\"version\":" + BookVersion.current() + "}");
            return;
        }
        if (!body.has("edits") || !body.get("edits").isJsonArray()) {
            send(x, 400, "{\"error\":\"expected an edits array\"}");
            return;
        }

        EditApplier.Result result;
        try {
            result = mc.submit(() -> {
                EditApplier.Result r = EditApplier.apply(file.get(), body.getAsJsonArray("edits"));
                // Fingerprint our own work before the watcher can see it, so this
                // edit is not reported a second time as if it came from in game.
                watch.sync(file.get());
                return r;
            }).get();
        } catch (Exception e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof EditApplier.BadEdit) {
                send(x, 400, "{\"error\":" + GSON.toJson(cause.getMessage()) + "}");
            } else {
                DragonscaleBridge.LOG.error("[questbridge] edit failed", cause);
                send(x, 500, "{\"error\":\"edit failed\"}");
            }
            return;
        }

        if (history != null) {
            history.touched(result.applied() + " edit" + (result.applied() == 1 ? "" : "s")
                + " to " + String.join(", ", result.touched()));
        }

        JsonObject change = new JsonObject();
        change.addProperty("version", result.version());
        change.addProperty("applied", result.applied());
        change.add("touched", GSON.toJsonTree(result.touched()));
        change.add("created", GSON.toJsonTree(result.created()));
        feed.publish(change);
        send(x, 200, change.toString());
    }

    /**
     * Reading the book touches FTB's live object graph, so it runs on the server
     * thread rather than the HTTP thread. A quest book is small; this costs a tick
     * at most, and racing the game thread would be a fine way to corrupt it.
     */
    private void book(HttpExchange x) throws IOException {
        var file = BookReader.file();
        if (file.isEmpty()) {
            send(x, 503, "{\"error\":\"quest file not loaded yet\"}");
            return;
        }
        String json;
        try {
            json = mc.submit(() -> BookReader.book(file.get()).toString()).get();
        } catch (Exception e) {
            DragonscaleBridge.LOG.error("[questbridge] reading the book failed", e);
            send(x, 500, "{\"error\":\"could not read the quest book\"}");
            return;
        }
        send(x, 200, json);
    }

    private void types(HttpExchange x) throws IOException {
        var file = BookReader.file();
        if (file.isEmpty()) {
            send(x, 503, "{\"error\":\"quest file not loaded yet\"}");
            return;
        }
        String json;
        try {
            json = mc.submit(() -> TypeIntrospector.types(file.get()).toString()).get();
        } catch (Exception e) {
            DragonscaleBridge.LOG.error("[questbridge] type introspection failed", e);
            send(x, 500, "{\"error\":\"could not introspect types\"}");
            return;
        }
        send(x, 200, json);
    }

    private void health(HttpExchange x) throws IOException {
        send(x, 200, """
            {"ok":true,"mcVersion":"%s","players":%d,"bookVersion":%d,"editors":%d,"bookLoaded":%b}"""
            .formatted(mc.getServerVersion(), mc.getPlayerCount(),
                BookVersion.current(), feed.count(), BookReader.file().isPresent()));
    }

    // --------------------------------------------------------------- plumbing --

    private HttpHandler authed(HttpHandler inner) {
        return x -> {
            String auth = x.getRequestHeaders().getFirst("Authorization");
            if (token.isBlank() || auth == null || !auth.equals("Bearer " + token)) {
                send(x, 401, "{\"error\":\"unauthorized\"}");
                return;
            }
            try {
                inner.handle(x);
            } catch (Exception e) {
                DragonscaleBridge.LOG.error("[questbridge] handler failed", e);
                send(x, 500, "{\"error\":\"internal\"}");
            }
        };
    }

    private static void send(HttpExchange x, int code, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        x.sendResponseHeaders(code, bytes.length);
        try (OutputStream out = x.getResponseBody()) {
            out.write(bytes);
        }
    }
}
