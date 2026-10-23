package com.abhyuday.djpal;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

/** Bridge setup: switch on the service, teach djay's buttons, test, capture. */
public class SetupActivity extends Activity {

    private static final int INK = Color.rgb(245, 241, 232), MUTED = Color.rgb(157, 151, 171),
            PANEL = Color.rgb(22, 19, 31), PINK = Color.rgb(255, 92, 138), GREEN = Color.rgb(74, 222, 128), AMBER = Color.rgb(255, 184, 77);
    private LinearLayout col;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Color.rgb(12, 10, 18));
        getWindow().setNavigationBarColor(Color.rgb(12, 10, 18));
    }

    @Override protected void onResume() { super.onResume(); build(); }

    private void build() {
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Color.rgb(12, 10, 18));
        col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(18), dp(28), dp(18), dp(40));
        sv.addView(col);

        TextView h = text("DJPal Bridge", 26, INK); h.setTypeface(Typeface.DEFAULT_BOLD); col.addView(h);
        col.addView(text("Lets DJPal put guest requests straight onto a djay deck.", 15, MUTED));

        boolean on = BridgeService.instance != null;
        boolean djay = Djay.find(this) != null;
        boolean d1 = Store.taught(this, "deck1"), d2 = Store.taught(this, "deck2");

        // 1. switch on
        LinearLayout c1 = card("1. Switch on the bridge", on ? "On" : "Off", on ? GREEN : PINK);
        c1.addView(text(on ? "DJPal Bridge is running."
                : "Open Accessibility, find DJPal Bridge under installed or downloaded apps, and switch it on.\n\nIf Android greys it out with \"Restricted setting\": tap App info below, then the ⋮ menu in the top corner, then Allow restricted settings. Come back and switch it on.", 14, MUTED));
        if (!on) {
            c1.addView(button("Open Accessibility settings", true, v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
            c1.addView(button("App info (for restricted settings)", false, v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())))));
        }

        // 2. djay
        LinearLayout c2 = card("2. djay", djay ? "Found" : "Not found", djay ? GREEN : PINK);
        c2.addView(text(djay ? "In djay, open Settings and turn OFF Start Playback, so a loaded song waits for you instead of playing over your mix. Set Apple Music as the library source."
                : "Install djay from the Play Store and sign in to Apple Music inside it.", 14, MUTED));
        if (djay) c2.addView(button("Open djay", false, v -> Djay.open(this)));

        // 3. teach
        LinearLayout c3 = card("3. Teach djay's buttons", d1 && d2 ? "Done" : "Needed", d1 && d2 ? GREEN : AMBER);
        c3.addView(text("Hold the phone the way you DJ (landscape, usually). DJPal opens djay and asks you to tap 4 spots: Deck 1's load button, the search box, the first result, Deck 2's load button. Takes 20 seconds. Redo it if djay updates and loading starts missing.", 14, MUTED));
        c3.addView(button("Teach djay now", true, on ? v -> BridgeService.instance.startTeach() : needOn()));

        // 4. test
        LinearLayout c4 = card("4. Test it", null, 0);
        c4.addView(text("Loads Kesariya onto Deck 1.", 14, MUTED));
        c4.addView(button("Load a test song", false, on ? v -> BridgeService.instance.load("Kesariya Pritam", "Kesariya", 1,
                (ok, msg) -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show()) : needOn()));

        // options
        LinearLayout c5 = card("Options", null, 0);
        Switch back = new Switch(this);
        back.setText("Come back to DJPal after loading");
        back.setTextColor(INK);
        back.setChecked(Store.flag(this, "comeBack", false));
        back.setOnCheckedChangeListener((CompoundButton b, boolean v) -> Store.setFlag(this, "comeBack", v));
        back.setPadding(0, dp(6), 0, dp(6));
        c5.addView(back);
        c5.addView(button("Forget taught buttons", false, v -> { Store.clearPoints(this); build(); }));

        // 5. capture
        LinearLayout c6 = card("If loading misses", null, 0);
        c6.addView(text("Open djay's library with the search showing and tap Capture. It shares a text map of djay's screen. Send that to Claude and the matching gets fixed.", 14, MUTED));
        c6.addView(button("Capture djay's screen", false, on ? v -> BridgeService.instance.startCapture() : needOn()));

        col.addView(button("Back to the party", true, v -> finish()));
        setContentView(sv);
    }

    private View.OnClickListener needOn() {
        return v -> Toast.makeText(this, "Switch on DJPal Bridge first (step 1).", Toast.LENGTH_LONG).show();
    }

    private LinearLayout card(String title, String badge, int badgeColor) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(14), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(PANEL); bg.setCornerRadius(dp(16)); bg.setStroke(dp(1), Color.argb(30, 255, 255, 255));
        c.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        col.addView(c, lp);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView t = text(title, 16, INK); t.setTypeface(Typeface.DEFAULT_BOLD);
        row.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        if (badge != null) { TextView bd = text(badge, 13, badgeColor); bd.setTypeface(Typeface.DEFAULT_BOLD); row.addView(bd); }
        c.addView(row);
        return c;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s); t.setTextSize(sp); t.setTextColor(color);
        t.setLineSpacing(0, 1.2f);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private Button button(String label, boolean hot, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label); b.setAllCaps(false); b.setTextSize(15);
        b.setTextColor(hot ? Color.WHITE : INK);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(hot ? PINK : Color.rgb(31, 26, 43)); bg.setCornerRadius(dp(12));
        if (!hot) bg.setStroke(dp(1), Color.argb(36, 255, 255, 255));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48));
        lp.topMargin = dp(10);
        b.setLayoutParams(lp);
        b.setOnClickListener(l);
        return b;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
