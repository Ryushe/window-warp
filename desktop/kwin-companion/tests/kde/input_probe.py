#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Adapter for the repository's isolated nested.sh --input-probe entry point."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parents[1] / 'native.py'), run_name='__main__')
