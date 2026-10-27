# Keep JavaScript interfaces so WebView bridge methods are not stripped
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keep class com.photobooth4u.booth.BTBridge {
    *;
}
