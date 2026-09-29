// canonicalId: c_283_1967  route: /283-1967
import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/unused_helper.dart';

class Frame12Screen extends StatelessWidget {
  const Frame12Screen({super.key});

  @override
  Widget build(BuildContext context) {
    // Matches the reference (frame 64, IR "Rectangle 7").
    return Scaffold(
      backgroundColor: AppTheme.brand,
      body: Stack(
        children: [
          Positioned(
            left: 24,
            top: 103.25,
            child: Container(
              width: 45,
              height: 45,
              color: const Color(0xFF12AE89),
              child: const Text('Group 4'),
            ),
          ),
          const _BackButton(),
          ElevatedButton(onPressed: () {}, child: const Text('Go')),
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
