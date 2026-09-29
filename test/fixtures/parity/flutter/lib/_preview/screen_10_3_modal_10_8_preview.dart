// GENERATED — variant preview entry: renders the base screen and AUTO-PRESENTS
// modal 'm_10_8' after the first frame via the contract presenter showModal_10_8(),
// so the modal is screenshot/verified over its (reused) base against its reference.
import 'package:flutter/material.dart';
import '../screens/screen_10_3.dart';

void main() => runApp(const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: _AutoPresentHost(),
    ));

class _AutoPresentHost extends StatefulWidget {
  const _AutoPresentHost();
  @override
  State<_AutoPresentHost> createState() => _AutoPresentHostState();
}

class _AutoPresentHostState extends State<_AutoPresentHost> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // The build contract REQUIRES the screen file to expose this presenter.
      showModal_10_8(context);
    });
  }

  @override
  Widget build(BuildContext context) => IPhone1415Pro57Screen();
}
