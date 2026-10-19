package dev.dragonscale.questbridge;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Pushes every applied change to connected editors.
 *
 * <p>This is server-sent events rather than a WebSocket. The contract originally
 * said WebSocket, but the traffic only ever flows one way — edits arrive by POST
 * and changes go out — so a socket buys nothing and costs a hand-rolled handshake
 * and frame codec inside a game server. SSE is plain HTTP, reconnects on its own in
 * every browser, and survives proxies that mangle upgrades.
 *
 * <p>Clients consume it with {@code new EventSource(...)} and apply each change
 * without reloading.
 */
public final class ChangeFeed {
    /** Proxies and phone radios drop idle connections; a comment line keeps them warm. */
    private static final int HEARTBEAT_SECONDS = 25;

    private final List<Subscriber> subscribers = new CopyOnWriteArrayList<>();
    private final ScheduledExecutorService heartbeat =
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "questbridge-sse-heartbeat");
            t.setDaemon(true);
            return t;
        });

    public ChangeFeed() {
        heartbeat.scheduleAtFixedRate(
            () -> writeAll(": ping\n\n"), HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);
    }

    /** Takes over the exchange and holds it open until the client goes away. */
    public void subscribe(HttpExchange x) throws IOException {
        x.getResponseHeaders().add("Content-Type", "text/event-stream; charset=utf-8");
        x.getResponseHeaders().add("Cache-Control", "no-cache");
        x.getResponseHeaders().add("Connection", "keep-alive");
        x.sendResponseHeaders(200, 0);          // 0 = chunked, stays open

        Subscriber sub = new Subscriber(x, x.getResponseBody());
        subscribers.add(sub);
        DragonscaleBridge.LOG.info("[questbridge] editor connected ({} total)", subscribers.size());

        // Tell a fresh client where the book currently is, so it knows whether the
        // snapshot it loaded is already behind.
        sub.write("event: hello\ndata: {\"version\":%d}\n\n".formatted(BookVersion.current()));
    }

    public void publish(JsonObject change) {
        writeAll("data: " + change + "\n\n");
    }

    private void writeAll(String payload) {
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        for (Subscriber s : subscribers) {
            if (!s.write(bytes)) {
                subscribers.remove(s);
                s.close();
                DragonscaleBridge.LOG.info("[questbridge] editor disconnected ({} left)", subscribers.size());
            }
        }
    }

    public int count() {
        return subscribers.size();
    }

    public void stop() {
        heartbeat.shutdownNow();
        for (Subscriber s : subscribers) s.close();
        subscribers.clear();
    }

    private record Subscriber(HttpExchange exchange, OutputStream out) {
        boolean write(String s) {
            return write(s.getBytes(StandardCharsets.UTF_8));
        }

        synchronized boolean write(byte[] bytes) {
            try {
                out.write(bytes);
                out.flush();
                return true;
            } catch (IOException e) {
                return false;     // client went away; the caller drops us
            }
        }

        void close() {
            try {
                exchange.close();
            } catch (Exception ignored) {
                // already gone
            }
        }
    }
}
