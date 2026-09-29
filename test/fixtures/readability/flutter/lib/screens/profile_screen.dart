import 'package:flutter/material.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  static const Color _accent = Color(0xFF304FFE);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _accent,
      body: Column(
        children: [
          const _BackButton(),
          // final old = OldWidget();
          GestureDetector(onTap: () {}, child: const Text('Tap')),
        ],
      ),
    );
  }
}

class _BackButton extends StatelessWidget {
  const _BackButton();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          Icon(Icons.arrow_back, size: 24, color: Colors.black),
          const SizedBox(width: 8),
          Text('Back', style: TextStyle(fontSize: 14, color: Colors.black)),
        ],
      ),
    );
  }
}
