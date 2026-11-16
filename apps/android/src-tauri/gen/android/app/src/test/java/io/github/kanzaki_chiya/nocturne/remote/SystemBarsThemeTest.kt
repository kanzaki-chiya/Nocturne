package io.github.kanzaki_chiya.nocturne.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class SystemBarsThemeTest {
  @Test fun invalidBackgroundStillUpdatesIcons() {
    for (light in listOf(true, false)) {
      for (background in listOf("", "invalid", "#fff", "#gggggg", "#ffffff00")) {
        val icons = mutableListOf<Boolean>()
        val colors = mutableListOf<Int>()
        SystemBarsTheme.apply(light, background, { icons.add(it) }, { colors.add(it) })
        assertEquals(listOf(light), icons)
        assertEquals(emptyList<Int>(), colors)
      }
    }
  }

  @Test fun validBackgroundUpdatesIconsAndOpaqueColor() {
    val icons = mutableListOf<Boolean>()
    val colors = mutableListOf<Int>()
    SystemBarsTheme.apply(true, "#fbfaf6", { icons.add(it) }, { colors.add(it) })
    SystemBarsTheme.apply(false, "#ABCDEF", { icons.add(it) }, { colors.add(it) })
    assertEquals(listOf(true, false), icons)
    assertEquals(listOf(0xfffbfaf6.toInt(), 0xffabcdef.toInt()), colors)
  }
}
