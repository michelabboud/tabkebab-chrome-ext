/* script.js — TabKebab Website Interactivity */

(function () {
  'use strict';

  // ── Dark Mode ──
  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  const icons = document.querySelectorAll('.theme-icon');

  function getEffectiveTheme() {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    icons.forEach(i => i.textContent = theme === 'dark' ? '\u2600' : '\u263E');
  }

  applyTheme(getEffectiveTheme());

  window.toggleTheme = function () {
    const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
  };

  toggle.addEventListener('click', window.toggleTheme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem('theme')) applyTheme(getEffectiveTheme());
  });

  // ── Sticky Nav Shadow ──
  const nav = document.getElementById('site-nav');
  const hero = document.querySelector('.hero');

  if (hero && nav) {
    const observer = new IntersectionObserver(
      ([entry]) => nav.classList.toggle('scrolled', !entry.isIntersecting),
      { threshold: 0, rootMargin: '-60px 0px 0px 0px' }
    );
    observer.observe(hero);
  }

  // ── Smooth Scroll (nav links + ToC pills) ──
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const id = link.getAttribute('href');
      if (id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();

      // If target is inside an accordion, expand it
      const accordion = target.closest('.accordion-item');
      if (accordion && !accordion.classList.contains('open')) {
        accordion.classList.add('open');
      }

      target.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Close mobile drawer if open
      closeDrawer();
    });
  });

  // ── Guide Accordion ──
  document.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.accordion-item');
      const wasOpen = item.classList.contains('open');

      // Toggle this one
      item.classList.toggle('open', !wasOpen);
    });
  });

  // ── Screenshot Lightbox ──
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = lightbox.querySelector('.lightbox-close');

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    lightboxImg.src = '';
    document.body.style.overflow = '';
  }

  document.querySelectorAll('[data-lightbox]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      openLightbox(el.getAttribute('data-lightbox'));
    });
  });

  lightbox.addEventListener('click', e => {
    if (e.target === lightbox || e.target === lightboxClose) {
      closeLightbox();
    }
  });

  lightboxClose.addEventListener('click', closeLightbox);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
  });

  // ── Mobile Hamburger Nav Drawer ──
  const hamburger = document.getElementById('hamburger');
  const drawer = document.getElementById('mobile-drawer');
  const overlay = document.getElementById('drawer-overlay');
  const drawerCloseBtn = document.getElementById('drawer-close');

  function openDrawer() {
    drawer.classList.add('open');
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    if (!lightbox.classList.contains('open')) {
      document.body.style.overflow = '';
    }
  }

  hamburger.addEventListener('click', openDrawer);
  drawerCloseBtn.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);

  document.querySelectorAll('.drawer-link').forEach(link => {
    link.addEventListener('click', closeDrawer);
  });

})();
