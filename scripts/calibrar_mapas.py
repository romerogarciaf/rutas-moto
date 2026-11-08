"""Dibuja, para cada zona, un mapa por perfil con los tramos de curvas detectados."""
import glob, json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

COL = {1: '#f2c200', 2: '#f07c12', 3: '#d6312b'}
ANCHO = {'motorway': 2.2, 'trunk': 2.0, 'primary': 1.6, 'secondary': 1.3, 'tertiary': 1.0, 'unclassified': 0.6}
for f in sorted(glob.glob('calibracion/*.json')):
    d = json.load(open(f))
    perfiles = list(d['perfiles'].keys())
    fig, axes = plt.subplots(1, len(perfiles), figsize=(8 * len(perfiles), 8.5))
    for ax, pf in zip(axes, perfiles):
        for c in d['carreteras']:
            ys, xs = zip(*c['c']); hw = c['hw'].replace('_link', '')
            ax.plot(xs, ys, color='#b5b9b2' if hw not in ('motorway', 'trunk') else '#e3a07a', lw=ANCHO.get(hw, 0.5), zorder=1)
        for t in d['perfiles'][pf]:
            ys, xs = zip(*t['c'])
            ax.plot(xs, ys, color=COL[t['lvl']], lw=5, solid_capstyle='round', zorder=3, alpha=.9)
        for l in d['lugares']:
            if l['t'] == 'town' or len(d['lugares']) < 60:
                ax.text(l['p'][1], l['p'][0], l['n'], fontsize=8, zorder=4, ha='center', color='#1b1f22')
        b = d['bbox']; ax.set_xlim(b['w'], b['e']); ax.set_ylim(b['s'], b['n'])
        ax.set_aspect(1 / 0.76); ax.set_xticks([]); ax.set_yticks([])
        km = sum(t['km'] for t in d['perfiles'][pf])
        ax.set_title(f"{d['zona']} · {pf}: {len(d['perfiles'][pf])} tramos, {km:.0f} km", fontsize=13)
    fig.tight_layout(); fig.savefig(f.replace('.json', '.png'), dpi=90)
    print('ok', f)
