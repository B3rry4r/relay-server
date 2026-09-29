import 'package:flutter/material.dart';
import 'screens/frame_12_screen.dart';
import 'screens/profile_screen.dart';

void main() => runApp(MaterialApp(
      routes: {
        '/a': (_) => const Frame12Screen(),
        '/b': (_) => const ProfileScreen(),
      },
    ));
