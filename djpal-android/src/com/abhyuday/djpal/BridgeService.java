package com.abhyuday.djpal;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Drives djay the way a person would: open djay, tap the deck's load button, type into
 * djay's search, tap the matching result. Only acts when DJPal asks it to.
 */
public class BridgeService extends AccessibilityService {

    interface Done { void done(boolean ok, String msg); }
    private interface Check { boolean ok(); }
    private interface Next { void run(boolean ok); }

    static BridgeService instance;

    private final Handler h = new Handler(Looper.getMainLooper());
    private boolean busy;
    private WindowManager wm;
    private View overlay;

    @Override protected void onServiceConnected() {
        instance = this;
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
    }
    @Override public boolean onUnbind(Intent intent) { instance = null; removeOverlay(); return super.onUnbind(intent); }
    @Override public void onDestroy() { instance = null; removeOverlay(); super.onDestroy(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* we poll the window when needed */ }
    @Override public void onInterrupt() {}

    // =================================================================
    // Load a song
    // =================================================================
    void load(final String query, final String title, final int deck, final Done cb) {
        if (busy) { cb.done(false, "Still busy with the last one, give it a second."); return; }
        final String pkg = Djay.find(this);
        if (pkg == null) { cb.done(false, "djay isn't installed on this phone."); return; }
        if (!Store.taught(this, "deck" + deck)) { cb.done(false, "Teach DJPal where Deck " + deck + "'s load button is first. Open Bridge setup, then Teach djay."); return; }
        busy = true;
        final Done end = (ok, msg) -> {
            busy = false;
            android.util.Log.i("DJPalBridge", "load deck" + deck + " \"" + query + "\" -> " + ok + ": " + msg);
            if (ok && Store.flag(this, "comeBack", false)) h.postDelayed(this::backToDJPal, 700);
            cb.done(ok, msg);
        };
        if (!Djay.open(this)) { end.done(false, "Couldn't open djay."); return; }

        waitFor(() -> djayFront(pkg), 15000, front -> {
            if (!front) { end.done(false, "djay didn't come up. Open it once by hand, then try again."); return; }
            // djay may rotate the screen when it opens; wait until the taught spot for this orientation exists
            waitFor(() -> Store.point(this, "deck" + deck) != null, 3000, settled -> h.postDelayed(() -> {
              final Point deckPt = Store.point(this, "deck" + deck);
              if (deckPt == null) {
                  end.done(false, "You taught djay held " + (Store.landscapeNow(this) ? "upright" : "sideways") + ", but the phone is " + (Store.landscapeNow(this) ? "sideways" : "upright") + " now. Teach it again holding the phone this way.");
                  return;
              }
              tap(deckPt.x, deckPt.y, () -> h.postDelayed(() ->
                typeSearch(query, typed -> {
                    if (!typed) { end.done(false, "Opened djay's library but couldn't type in the search box. Use Capture in Bridge setup and send it to Claude."); return; }
                    pickResult(title, picked -> {
                        if (!picked) { end.done(false, "Searched djay for \"" + query + "\" but didn't see it. Check Apple Music is the library source in djay."); return; }
                        h.postDelayed(() -> end.done(true, "Loaded on Deck " + deck + "."), 900);
                    });
                }), 1100));
            }, settled ? 500 : 0));
        });
    }

    private boolean djayFront(String pkg) {
        AccessibilityNodeInfo r = getRootInActiveWindow();
        return r != null && r.getPackageName() != null && pkg.contentEquals(r.getPackageName());
    }

    /** Finds djay's search field, taps the taught spot if it isn't visible yet, and types the query. */
    private void typeSearch(final String query, final Next next) {
        AccessibilityNodeInfo field = findEditable();
        if (field != null) { next.run(setText(field, query)); return; }
        final Point sp = Store.point(this, "search");
        Runnable afterTap = () -> waitFor(() -> findEditable() != null, 2500, found -> {
            AccessibilityNodeInfo f = findEditable();
            next.run(found && f != null && setText(f, query));
        });
        AccessibilityNodeInfo hinted = findSearchLike();
        if (hinted != null) { Rect b = new Rect(); hinted.getBoundsInScreen(b); tap(b.centerX(), b.centerY(), () -> h.postDelayed(afterTap, 500)); }
        else if (sp != null) tap(sp.x, sp.y, () -> h.postDelayed(afterTap, 500));
        else afterTap.run();
    }

    private boolean setText(AccessibilityNodeInfo f, String text) {
        f.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        f.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        if (!ok) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) { cm.setPrimaryClip(ClipData.newPlainText("song", text)); ok = f.performAction(AccessibilityNodeInfo.ACTION_PASTE); }
        }
        if (ok && Build.VERSION.SDK_INT >= 30) {
            f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return ok;
    }

    /** Waits for a row that matches the song title under the search box and taps it. */
    private void pickResult(final String title, final Next next) {
        final String want = norm(title);
        final String[] words = want.split(" ");
        final StringBuilder head = new StringBuilder();
        for (int i = 0; i < Math.min(3, words.length); i++) head.append(i > 0 ? " " : "").append(words[i]);
        final String key = head.toString();
        final AccessibilityNodeInfo[] hit = new AccessibilityNodeInfo[1];
        waitFor(() -> (hit[0] = findResult(key)) != null, 6000, found -> {
            if (found && hit[0] != null) {
                Rect b = new Rect();
                hit[0].getBoundsInScreen(b);
                tap(b.centerX(), b.centerY(), () -> next.run(true));
                return;
            }
            Point rp = Store.point(this, "result");
            if (rp != null) tap(rp.x, rp.y, () -> next.run(true));
            else next.run(false);
        });
    }

    private AccessibilityNodeInfo findResult(String key) {
        if (key.isEmpty()) return null;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo field = findEditable();
        int below = 0;
        if (field != null) { Rect fb = new Rect(); field.getBoundsInScreen(fb); below = fb.bottom - 4; }
        DisplayMetrics dm = getResources().getDisplayMetrics();
        AccessibilityNodeInfo best = null;
        int bestTop = Integer.MAX_VALUE;
        for (AccessibilityNodeInfo n : walk(root)) {
            if (n.isEditable()) continue;
            String t = norm(String.valueOf(n.getText() == null ? "" : n.getText()) + " " + (n.getContentDescription() == null ? "" : n.getContentDescription()));
            if (!t.contains(key)) continue;
            Rect b = new Rect(); n.getBoundsInScreen(b);
            if (b.isEmpty() || b.top < below || b.top > dm.heightPixels || b.left > dm.widthPixels) continue;
            if (b.top < bestTop) { best = n; bestTop = b.top; }
        }
        return best;
    }

    private AccessibilityNodeInfo findEditable() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f != null && f.isEditable()) return f;
        for (AccessibilityNodeInfo n : walk(root)) {
            CharSequence cls = n.getClassName();
            if (n.isEditable() || (cls != null && cls.toString().endsWith("EditText"))) {
                Rect b = new Rect(); n.getBoundsInScreen(b);
                if (!b.isEmpty() && n.isVisibleToUser()) return n;
            }
        }
        return null;
    }

    private AccessibilityNodeInfo findSearchLike() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        for (AccessibilityNodeInfo n : walk(root)) {
            String s = (n.getText() + " " + n.getContentDescription() + " " + n.getViewIdResourceName()).toLowerCase(Locale.US);
            if (s.contains("search") && n.isVisibleToUser()) { Rect b = new Rect(); n.getBoundsInScreen(b); if (!b.isEmpty()) return n; }
        }
        return null;
    }

    private static List<AccessibilityNodeInfo> walk(AccessibilityNodeInfo root) {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);
        while (!q.isEmpty() && out.size() < 4000) {
            AccessibilityNodeInfo n = q.poll();
            if (n == null) continue;
            out.add(n);
            for (int i = 0; i < n.getChildCount(); i++) { AccessibilityNodeInfo c = n.getChild(i); if (c != null) q.add(c); }
        }
        return out;
    }

    static String norm(String s) {
        if (s == null) return "";
        return s.toLowerCase(Locale.US)
                .replaceAll("\\([^)]*\\)|\\[[^]]*]", " ")
                .replaceAll("[^\\p{L}\\p{N}]+", " ")
                .trim().replaceAll(" +", " ");
    }

    // =================================================================
    // Gestures and waiting
    // =================================================================
    private void tap(int x, int y, final Runnable after) {
        Path p = new Path();
        p.moveTo(Math.max(0, x), Math.max(0, y));
        GestureDescription g = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(p, 0, 60)).build();
        boolean sent = dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { h.postDelayed(after, 150); }
            @Override public void onCancelled(GestureDescription d) { h.postDelayed(after, 150); }
        }, null);
        if (!sent) h.postDelayed(after, 150);
    }

    private void waitFor(final Check c, final long timeoutMs, final Next next) {
        final long until = System.currentTimeMillis() + timeoutMs;
        h.post(new Runnable() {
            @Override public void run() {
                boolean ok;
                try { ok = c.ok(); } catch (Exception e) { ok = false; }
                if (ok) { next.run(true); return; }
                if (System.currentTimeMillis() > until) { next.run(false); return; }
                h.postDelayed(this, 300);
            }
        });
    }

    private void backToDJPal() {
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        startActivity(i);
    }

    private void toast(String s) { h.post(() -> Toast.makeText(this, s, Toast.LENGTH_LONG).show()); }

    // =================================================================
    // Teach mode: the user taps each djay button once over a see-through layer
    // =================================================================
    private static final String[][] STEPS = {
            {"deck1", "Tap Deck 1's load button (the music note on the left deck)."},
            {"search", "Now tap djay's search box."},
            {"result", "Tap the first song in the results. It will load on Deck 1."},
            {"deck2", "Last one. Tap Deck 2's load button."}
    };
    private int step;
    private boolean bannerTop = false;

    void startTeach() {
        if (Djay.find(this) == null) { toast("djay isn't installed on this phone."); return; }
        if (busy) { toast("Busy, try again in a second."); return; }
        busy = true;
        step = 0;
        Djay.open(this);
        final String pkg = Djay.find(this);
        waitFor(() -> djayFront(pkg), 15000, ok -> h.postDelayed(this::showTeachStep, 900));
    }

    private void showTeachStep() {
        removeOverlay();
        if (step >= STEPS.length) {
            busy = false;
            performGlobalAction(GLOBAL_ACTION_BACK);
            toast("Done. DJPal knows djay's buttons now.");
            h.postDelayed(this::backToDJPal, 1200);
            return;
        }
        final String name = STEPS[step][0];
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.argb(40, 255, 92, 138));
        root.setOnTouchListener((v, e) -> {
            if (e.getAction() != MotionEvent.ACTION_UP) return true;
            final int x = Math.round(e.getRawX()), y = Math.round(e.getRawY());
            Store.setPoint(this, name, x, y);
            removeOverlay();
            h.postDelayed(() -> tap(x, y, this::afterTeachTap), 120);
            return true;
        });

        LinearLayout banner = new LinearLayout(this);
        banner.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(14);
        banner.setPadding(pad, pad, pad, pad);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.rgb(31, 26, 43));
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), Color.rgb(255, 92, 138));
        banner.setBackground(bg);
        banner.setOnTouchListener((v, e) -> true);

        TextView t = new TextView(this);
        t.setText("Teaching DJPal  " + (step + 1) + " of " + STEPS.length + "\n" + STEPS[step][1]);
        t.setTextColor(Color.rgb(245, 241, 232));
        t.setTextSize(15);
        banner.addView(t);

        LinearLayout row = new LinearLayout(this);
        row.setPadding(0, dp(10), 0, 0);
        row.addView(smallButton("Skip", v -> { step++; showTeachStep(); }));
        row.addView(smallButton("Move this box", v -> { bannerTop = !bannerTop; showTeachStep(); }));
        row.addView(smallButton("Cancel", v -> { removeOverlay(); busy = false; toast("Teaching cancelled."); }));
        banner.addView(row);

        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(dp(330), FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL | (bannerTop ? Gravity.TOP : Gravity.BOTTOM));
        blp.topMargin = dp(24); blp.bottomMargin = dp(24);
        root.addView(banner, blp);
        addOverlay(root, true);
    }

    private void afterTeachTap() {
        String done = STEPS[step][0];
        step++;
        if ("search".equals(done)) {
            // type a sample so there are results to tap in the next step
            h.postDelayed(() -> {
                AccessibilityNodeInfo f = findEditable();
                if (f != null && setText(f, "Kesariya")) h.postDelayed(this::showTeachStep, 2200);
                else { toast("Couldn't type for you. Type any song in djay's search now, I'll be back in 10 seconds."); h.postDelayed(this::showTeachStep, 10000); }
            }, 600);
        } else if ("result".equals(done)) {
            h.postDelayed(this::showTeachStep, 1800);
        } else {
            h.postDelayed(this::showTeachStep, 1200);
        }
    }

    // =================================================================
    // Capture: dump what djay exposes so Claude can tune the matching
    // =================================================================
    void startCapture() {
        if (Djay.find(this) == null) { toast("djay isn't installed on this phone."); return; }
        Djay.open(this);
        h.postDelayed(() -> {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.HORIZONTAL);
            int pad = dp(8);
            box.setPadding(pad, pad, pad, pad);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.rgb(31, 26, 43)); bg.setCornerRadius(dp(14)); bg.setStroke(dp(1), Color.rgb(255, 184, 77));
            box.setBackground(bg);
            box.addView(smallButton("Capture this screen", v -> {
                removeOverlay();
                h.postDelayed(() -> shareText(dump()), 300);
            }));
            box.addView(smallButton("Cancel", v -> removeOverlay()));
            addOverlay(box, false);
            toast("Open djay's library with the search box showing, then tap Capture.");
        }, 1200);
    }

    String dump() {
        StringBuilder sb = new StringBuilder();
        DisplayMetrics dm = getResources().getDisplayMetrics();
        sb.append("DJPal capture  ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append("  Android ").append(Build.VERSION.RELEASE)
                .append("  screen ").append(dm.widthPixels).append('x').append(dm.heightPixels).append('\n');
        String[] names = {"deck1", "deck2", "search", "result"};
        for (String n : names) { Point p = Store.point(this, n); sb.append("taught ").append(n).append(": ").append(p == null ? "-" : p.x + "," + p.y).append('\n'); }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) { sb.append("No window content visible.\n"); return sb.toString(); }
        sb.append("package ").append(root.getPackageName()).append('\n');
        dumpNode(root, 0, sb, new int[]{0});
        return sb.toString();
    }

    private void dumpNode(AccessibilityNodeInfo n, int depth, StringBuilder sb, int[] count) {
        if (n == null || count[0]++ > 1500) return;
        Rect b = new Rect(); n.getBoundsInScreen(b);
        for (int i = 0; i < depth; i++) sb.append("  ");
        String cls = n.getClassName() == null ? "?" : n.getClassName().toString();
        sb.append(cls.substring(cls.lastIndexOf('.') + 1));
        if (n.getText() != null) sb.append(" text=\"").append(n.getText()).append('"');
        if (n.getContentDescription() != null) sb.append(" desc=\"").append(n.getContentDescription()).append('"');
        if (n.getViewIdResourceName() != null) sb.append(" id=").append(n.getViewIdResourceName());
        if (Build.VERSION.SDK_INT >= 26 && n.getHintText() != null) sb.append(" hint=\"").append(n.getHintText()).append('"');
        sb.append(' ').append(b.toShortString());
        if (n.isEditable()) sb.append(" EDITABLE");
        if (n.isClickable()) sb.append(" click");
        sb.append('\n');
        for (int i = 0; i < n.getChildCount(); i++) dumpNode(n.getChild(i), depth + 1, sb, count);
    }

    private void shareText(String s) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, "DJPal djay capture");
        send.putExtra(Intent.EXTRA_TEXT, s);
        Intent chooser = Intent.createChooser(send, "Send the capture to yourself");
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(chooser);
    }

    // =================================================================
    // Overlay helpers
    // =================================================================
    private void addOverlay(View v, boolean fullScreen) {
        if (wm == null) return;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                fullScreen ? WindowManager.LayoutParams.MATCH_PARENT : WindowManager.LayoutParams.WRAP_CONTENT,
                fullScreen ? WindowManager.LayoutParams.MATCH_PARENT : WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | (fullScreen ? 0 : WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE),
                PixelFormat.TRANSLUCENT);
        if (Build.VERSION.SDK_INT >= 28) lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        if (!fullScreen) { lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL; lp.y = dp(40); }
        try { wm.addView(v, lp); overlay = v; } catch (Exception e) { toast("Couldn't show the helper box: " + e.getMessage()); busy = false; }
    }

    private void removeOverlay() {
        if (overlay != null && wm != null) { try { wm.removeView(overlay); } catch (Exception ignored) { } }
        overlay = null;
    }

    private Button smallButton(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setTextColor(Color.rgb(245, 241, 232));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.rgb(46, 40, 64)); bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        b.setPadding(dp(12), 0, dp(12), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(38));
        lp.setMarginEnd(dp(8));
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
