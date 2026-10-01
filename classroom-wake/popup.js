const box = document.getElementById('planB');
chrome.storage.local.get('planB').then(({ planB = false }) => { box.checked = planB; });
box.addEventListener('change', () => chrome.storage.local.set({ planB: box.checked }));
