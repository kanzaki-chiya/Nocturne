package io.github.kanzaki_chiya.nocturne.remote

object SystemBarsTheme {
  fun apply(light: Boolean, background: String, setLight: (Boolean) -> Unit, setBackground: (Int) -> Unit) {
    setLight(light)
    if (Regex("^#[0-9a-fA-F]{6}$").matches(background)) {
      setBackground((0xff000000L or background.drop(1).toLong(16)).toInt())
    }
  }
}
