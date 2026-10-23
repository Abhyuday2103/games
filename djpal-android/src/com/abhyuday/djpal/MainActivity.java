package com.abhyuday.djpal;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/** Runs the DJPal web app and exposes window.DJPalBridge so its Load buttons can drive djay. */
public class MainActivity extends Activity {

    static final String HOST = "abhyuday2103.github.io";
    static final String URL = "https://" + HOST + "/games/djpal/?app=1";

    private WebView web;
    private final Handler h = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(12, 10, 18));
        getWindow().setNavigationBarColor(Color.rgb(12, 10, 18));

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(12, 10, 18));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " DJPalApp/1");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/games/djpal")) return false;
                // Apple Music, YouTube Music and everything else open in their own apps
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showOffline();
            }
        });
        web.addJavascriptInterface(new Bridge(), "DJPalBridge");
        setContentView(web);
        if (b != null) web.restoreState(b);
        else web.loadUrl(URL);
    }

    /** Friendly screen instead of Android's error page, with retry and a way into Bridge setup. */
    private void showOffline() {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;background:#0c0a12;color:#f5f1e8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center'>"
                + "<div style='padding:24px;max-width:420px'><div style='font-size:44px;font-weight:800'>DJ<span style='color:#ff5c8a'>Pal</span></div>"
                + "<p style='color:#9d97ab;line-height:1.5'>Can't reach the internet right now, so the party page didn't load. Your queue is saved and comes back when it does.</p>"
                + "<button onclick=\"location.replace('" + URL + "')\" style='width:100%;height:48px;border:0;border-radius:12px;background:#ff5c8a;color:#fff;font-size:16px;font-weight:600;margin-top:10px'>Try again</button>"
                + "<button onclick='DJPalBridge.setup()' style='width:100%;height:48px;border:1px solid #3a3450;border-radius:12px;background:#1f1a2b;color:#f5f1e8;font-size:16px;margin-top:10px'>Bridge setup</button>"
                + "</div></body>";
        h.post(() -> web.loadDataWithBaseURL("https://" + HOST + "/offline", html, "text/html", "utf-8", null));
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    // Leaving the app must not end the party, so Back just sends DJPal to the background.
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { moveTaskToBack(true); }

    @Override protected void onResume() {
        super.onResume();
        web.evaluateJavascript("window.onDJPalBridgeStatus && window.onDJPalBridgeStatus()", null);
    }

    private void reply(String id, boolean ok, String msg) {
        String js = "window.onDJPalBridge && window.onDJPalBridge(" + JSONObject.quote(id) + "," + ok + "," + JSONObject.quote(msg) + ")";
        h.post(() -> web.evaluateJavascript(js, null));
    }

    final class Bridge {
        @JavascriptInterface public String status() {
            try {
                JSONObject o = new JSONObject();
                o.put("ready", BridgeService.instance != null);
                o.put("djay", Djay.find(MainActivity.this) != null);
                o.put("deck1", Store.taught(MainActivity.this, "deck1"));
                o.put("deck2", Store.taught(MainActivity.this, "deck2"));
                o.put("version", 1);
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface public void load(String json) {
            final String id, query, title;
            final int deck;
            try {
                JSONObject o = new JSONObject(json);
                id = o.optString("id");
                query = o.optString("query");
                title = o.optString("title");
                deck = o.optInt("deck", 1) == 2 ? 2 : 1;
            } catch (Exception e) { return; }
            h.post(() -> {
                BridgeService svc = BridgeService.instance;
                if (svc == null) { reply(id, false, "Switch on DJPal Bridge in Accessibility first. Tap Bridge setup."); return; }
                svc.load(query, title, deck, (ok, msg) -> reply(id, ok, msg));
            });
        }

        @JavascriptInterface public void setup() {
            h.post(() -> startActivity(new Intent(MainActivity.this, SetupActivity.class)));
        }

        @JavascriptInterface public void openDjay() {
            h.post(() -> Djay.open(MainActivity.this));
        }
    }
}
