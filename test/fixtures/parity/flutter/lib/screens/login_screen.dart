// canonicalId: c_10_1  route: /login
// states: default
import 'package:flutter/material.dart';
import '../app_routes.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Image.asset('assets/images/user_avatar_10_31.png', width: 64, height: 64),
            const _PillButton(label: 'Sign in'),
            ElevatedButton(
              onPressed: () => Navigator.pushNamed(context, AppRoutes.home),
              child: const Text('Sign in'),
            ),
          ],
        ),
      ),
    );
  }
}

class _PillButton extends StatelessWidget {
  const _PillButton({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(color: const Color(0xFF12AE89), borderRadius: BorderRadius.circular(12)),
      child: Text(label),
    );
  }
}
