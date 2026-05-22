FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html style.css script.js db.js boards.js theme.js sw.js /usr/share/nginx/html/

COPY README.md /usr/share/nginx/html/README.md

EXPOSE 360

CMD ["nginx", "-g", "daemon off;"]
