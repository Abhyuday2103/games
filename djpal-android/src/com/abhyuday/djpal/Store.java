package com.abhyuday.djpal;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Point;
import android.view.WindowManager;

/** Taught tap positions for djay, saved separately for landscape and portrait. */
final class Store {
    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("djpal", Context.MODE_PRIVATE);
    }

    /** Orientation of the screen right now, from the real display size (not the calling app's layout). */
    @SuppressWarnings("deprecation")
    static String orient(Context c) {
        WindowManager wm = (WindowManager) c.getSystemService(Context.WINDOW_SERVICE);
        Point p = new Point();
        if (wm != null) wm.getDefaultDisplay().getRealSize(p);
        else { p.x = c.getResources().getDisplayMetrics().widthPixels; p.y = c.getResources().getDisplayMetrics().heightPixels; }
        return p.x > p.y ? "L." : "P.";
    }

    static boolean landscapeNow(Context c) { return "L.".equals(orient(c)); }

    /** Taught in either orientation. */
    static boolean taught(Context c, String name) {
        SharedPreferences p = prefs(c);
        return p.contains("L." + name + ".x") || p.contains("P." + name + ".x");
    }

    static Point point(Context c, String name) {
        SharedPreferences p = prefs(c);
        String k = orient(c) + name;
        if (!p.contains(k + ".x")) return null;
        return new Point(p.getInt(k + ".x", 0), p.getInt(k + ".y", 0));
    }

    static void setPoint(Context c, String name, int x, int y) {
        String k = orient(c) + name;
        prefs(c).edit().putInt(k + ".x", x).putInt(k + ".y", y).apply();
    }

    static void clearPoints(Context c) {
        SharedPreferences.Editor e = prefs(c).edit();
        for (String o : new String[]{"L.", "P."})
            for (String n : new String[]{"deck1", "deck2", "search", "result"}) { e.remove(o + n + ".x"); e.remove(o + n + ".y"); }
        e.apply();
    }

    static boolean flag(Context c, String name, boolean def) { return prefs(c).getBoolean(name, def); }
    static void setFlag(Context c, String name, boolean v) { prefs(c).edit().putBoolean(name, v).apply(); }
}
