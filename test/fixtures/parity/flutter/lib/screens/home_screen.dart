// canonicalId: c_10_2  route: /home
// states: default
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../app_routes.dart';
import '../resources/app_assets.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    const bannerKey = 'promo';
    final banners = <String, String>{'promo': AppAssets.promoBanner};
    return Scaffold(
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const _SectionHeading(title: 'Home'),
          SvgPicture.asset('assets/icons/vector_10_20.svg', width: 18, height: 18),
          Image.asset(banners[bannerKey]!),
          Container(
            decoration: BoxDecoration(color: const Color(0xFF12AE89), borderRadius: BorderRadius.circular(12)),
            child: Image.asset(AppAssets.mapDark),
          ),
          TextButton(onPressed: () {}, child: const Text('Settings')),
          TextButton(
            onPressed: () => Navigator.pushNamed(context, AppRoutes.details),
            child: const Text('View details'),
          ),
          TextButton(
            onPressed: () => Navigator.pushNamed(context, AppRoutes.filter),
            child: const Text('Filter'),
          ),
        ],
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
