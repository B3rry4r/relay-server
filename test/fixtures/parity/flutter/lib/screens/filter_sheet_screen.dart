// canonicalId: c_10_9  route: /10-9
// states: default
import 'package:flutter/material.dart';
import 'home_screen.dart';

class FilterSheetScreen extends StatelessWidget {
  const FilterSheetScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          const Positioned.fill(child: IgnorePointer(child: HomeScreen())),
          const Positioned.fill(child: ColoredBox(color: Color(0x80000000))),
          Align(
            alignment: Alignment.bottomCenter,
            child: _FilterSheet(),
          ),
        ],
      ),
    );
  }
}

class _FilterSheet extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      height: 240,
      color: Colors.white,
      child: const Center(child: Text('Filter')),
    );
  }
}
