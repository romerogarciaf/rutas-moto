#!/usr/bin/env python3
"""Convierte el inventario de radares de la DGT (DATEX II) en data/radares.json.

Fuente oficial: Dirección General de Tráfico, Punto de Acceso Nacional
(https://nap.dgt.es/dataset/radares-fijos-dgt).
Uso: python3 scripts/radares.py ENTRADA.xml SALIDA.json
"""
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

NS = '{http://datex2.eu/schema/1_0/1_0}'
XSI = '{http://www.w3.org/2001/XMLSchema-instance}type'


def coords(el):
    pc = el.find(f'.//{NS}pointCoordinates') if el is not None else None
    if pc is None:
        return None
    try:
        return [round(float(pc.find(f'{NS}latitude').text), 5), round(float(pc.find(f'{NS}longitude').text), 5)]
    except (AttributeError, ValueError):
        return None


def texto(el, ruta):
    x = el.find(ruta)
    return x.text.strip() if x is not None and x.text else ''


def main(entrada, salida):
    raiz = ET.parse(entrada).getroot()
    pub = texto(raiz, f'.//{NS}publicationTime')
    radares = []
    for loc in raiz.iter(f'{NS}predefinedLocation'):
        ident = loc.get('id') or ''
        if not ident.startswith('GUID_'):
            continue
        interno = loc.find(f'{NS}predefinedLocation')
        if interno is None:
            continue
        tipo_xml = interno.get(XSI, '')
        ref = interno.find(f'{NS}referencePoint')
        carretera = texto(ref, f'{NS}roadNumber') if ref is not None else ''
        pk = ''
        if ref is not None:
            try:
                pk = round(float(texto(ref, f'{NS}referencePointDistance')) / 1000, 1)
            except ValueError:
                pk = ''
        provincia = texto(ref, f'{NS}administrativeArea/{NS}value') if ref is not None else ''
        r = {'id': ident.replace('GUID_', ''), 'carretera': carretera, 'pk': pk, 'provincia': provincia}
        if tipo_xml.endswith('Linear'):
            ini = coords(interno.find(f'.//{NS}from'))
            fin = coords(interno.find(f'.//{NS}to'))
            if not ini:
                continue
            r.update(tipo='tramo', p=ini, fin=fin)
            if not carretera:
                r['carretera'] = texto(interno, f'.//{NS}from//{NS}descriptor/{NS}value')
        else:
            p = coords(interno)
            if not p:
                continue
            r.update(tipo='fijo', p=p)
            if not carretera:
                r['carretera'] = texto(interno, f'.//{NS}descriptor/{NS}value')
        radares.append(r)
    datos = {
        'fuente': 'Dirección General de Tráfico (DGT) – Punto de Acceso Nacional, inventario de radares fijos y de tramo',
        'publicado': pub,
        'convertido': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'radares': radares,
    }
    with open(salida, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(radares)} radares ({sum(r["tipo"] == "tramo" for r in radares)} de tramo), publicado {pub}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
