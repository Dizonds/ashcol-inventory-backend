@echo off
echo Starting ASHCOL MongoDB Replica Set rs0 on port 27018...
"C:\Program Files\MongoDB\Server\8.3\bin\mongod.exe" --dbpath "C:\Users\usher\ASHCOL\.local-mongo" --replSet rs0 --bind_ip 127.0.0.1 --port 27018

