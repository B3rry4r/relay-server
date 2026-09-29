// canonicalId: c_10_3  route: /10-3
// states: default
// modals: m_10_8
import 'package:flutter/material.dart';
import '../app_routes.dart';

/// Presenter the P1-core contract requires for folded modal m_10_8. It is DECLARED
/// here but no control on this screen ever calls it — only the verify preview does.
void showModal_10_8(BuildContext context) {
  showDialog<void>(context: context, builder: (_) => const AlertDialog(title: Text('Log out?')));
}

class IPhone1415Pro57Screen extends StatelessWidget {
  const IPhone1415Pro57Screen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            const _SectionHeading(title: 'Settings'),
            TextButton(onPressed: () {}, child: const Text('Resolve')),
            TextButton(
              onPressed: () => Navigator.pushNamed(context, AppRoutes.login),
              child: const Text('Sign out'),
            ),
            const _PillButton(label: 'Save'),
            TextButton(onPressed: () {}, child: const Text('Log out')),
          ],
        ),
      ),
    );
  }
}

class _SectionHeading extends StatelessWidget {
  const _SectionHeading({required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
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
      decoration: BoxDecoration(color: const Color(0xFF1A1A1A), borderRadius: BorderRadius.circular(12)),
      child: Text(label),
    );
  }
}
