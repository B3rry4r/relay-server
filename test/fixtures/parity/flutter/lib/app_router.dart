// GENERATED SKELETON — write-locked router.
import 'package:flutter/material.dart';
import 'app_routes.dart';
import 'theme/app_theme.dart';
import 'screens/login_screen.dart';
import 'screens/app_shell.dart';
import 'screens/screen_10_3.dart';
import 'screens/details_screen.dart';
import 'screens/filter_sheet_screen.dart';

class AppRouter extends StatelessWidget {
  const AppRouter({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: appTheme(),
      initialRoute: AppRoutes.entry,
      onGenerateRoute: (settings) {
        switch (settings.name) {
      case '/login': return MaterialPageRoute(builder: (_) => const LoginScreen());
      case '/home': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: 0));
      case '/10-4': return MaterialPageRoute(builder: (_) => const AppShell(initialIndex: 1));
      case '/10-3': return MaterialPageRoute(builder: (_) => const IPhone1415Pro57Screen());
      case '/details': return MaterialPageRoute(builder: (_) => const DetailsScreen());
      case '/10-9': return MaterialPageRoute(builder: (_) => const FilterSheetScreen());
        }
        return MaterialPageRoute(builder: (_) => const LoginScreen());
      },
    );
  }
}
