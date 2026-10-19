package dev.dragonscale.questbridge;

import com.mojang.logging.LogUtils;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import org.slf4j.Logger;

/**
 * Serves the live FTB Quests book over HTTP so it can be edited from outside the
 * game, and keeps a git history of every change.
 *
 * <p>The server is the only authority on the book. Nothing outside the game writes
 * a quest file directly: edits are applied through FTB's own API, which means
 * serialization, addon fields and the lang-file split stay FTB's problem rather
 * than ours.
 *
 * <p>Read-only for now. {@code /ops} does not exist yet, so nothing external can
 * modify the book until the read path is proven.
 */
@Mod(DragonscaleBridge.MOD_ID)
public class DragonscaleBridge {
    public static final String MOD_ID = "dragonscalebridge";
    public static final Logger LOG = LogUtils.getLogger();

    private BridgeServer server;

    public DragonscaleBridge(IEventBus modBus, ModContainer container) {
        NeoForge.EVENT_BUS.addListener(this::onServerStarted);
        NeoForge.EVENT_BUS.addListener(this::onServerStopping);
        LOG.info("[questbridge] loaded");
    }

    private void onServerStarted(ServerStartedEvent event) {
        try {
            server = new BridgeServer(event.getServer());
            server.start();
        } catch (Exception e) {
            LOG.error("[questbridge] failed to start; the game is unaffected", e);
            server = null;
        }
    }

    private void onServerStopping(ServerStoppingEvent event) {
        if (server != null) {
            server.stop();
            server = null;
        }
    }
}
