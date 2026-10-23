package com.abhyuday.djpal;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.List;
import java.util.Locale;

/** Finds the installed djay app, whatever its package name turns out to be. */
final class Djay {
    private Djay() {}

    private static String cached;

    static String find(Context c) {
        PackageManager pm = c.getPackageManager();
        if (cached != null && pm.getLaunchIntentForPackage(cached) != null) return cached;
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(main, 0);
        String best = null;
        for (ResolveInfo r : apps) {
            String pkg = r.activityInfo.packageName;
            String label = String.valueOf(r.loadLabel(pm)).toLowerCase(Locale.US);
            boolean algo = pkg.toLowerCase(Locale.US).contains("algoriddim");
            if (algo && label.contains("djay")) { best = pkg; break; }
            if (algo || label.startsWith("djay")) best = pkg;
        }
        cached = best;
        return best;
    }

    static boolean open(Context c) {
        String pkg = find(c);
        if (pkg == null) return false;
        Intent i = c.getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) return false;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        c.startActivity(i);
        return true;
    }
}
