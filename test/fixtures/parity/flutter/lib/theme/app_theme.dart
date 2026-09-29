// GENERATED (extract-first design system). Single source of truth for the
// palette + type scale + spacing/radius. Screens MUST import these tokens instead
// of hardcoding raw literals. Safe to extend; do not duplicate tokens per screen.
import 'package:flutter/material.dart';

class AppTheme {
  AppTheme._();

  // ── Colors (role-classified, usage-ordered) ──
  static const Color brand = Color(0xff12ae89); // #12ae89
  static const Color ink = Color(0xff1a1a1a); // #1a1a1a (neutral)
  static const Color surface = Color(0xffffffff); // #ffffff (neutral)

  // ── Spacing scale ──
  static const double s4 = 4, s8 = 8, s12 = 12, s16 = 16, s20 = 20, s24 = 24, s32 = 32;
  static EdgeInsets pad(double v) => EdgeInsets.all(v);
  static EdgeInsets padX(double v) => EdgeInsets.symmetric(horizontal: v);
  static EdgeInsets padY(double v) => EdgeInsets.symmetric(vertical: v);

  // ── Radius scale ──
  static const BorderRadius r8 = BorderRadius.all(Radius.circular(8));
  static const BorderRadius r12 = BorderRadius.all(Radius.circular(12));
  static const BorderRadius r16 = BorderRadius.all(Radius.circular(16));
  static const BorderRadius r24 = BorderRadius.all(Radius.circular(24));

  static ThemeData themeData() => ThemeData(
        useMaterial3: true,
        colorSchemeSeed: brand,
        scaffoldBackgroundColor: surface,
      );
}

// Back-compat alias: the generated router (lib/app_router.dart) calls appTheme().
ThemeData appTheme() => AppTheme.themeData();
